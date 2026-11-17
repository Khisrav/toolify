/**
 * Priority job queue on top of a worker pool.
 * - `interactive` jobs jump ahead of `batch` jobs; FIFO within a priority.
 * - Abort a queued job → removed. Abort a running job → cooperative cancel, then
 *   terminate the worker if the job has not settled within `cancelGraceMs`.
 * - A job that crashes its worker (e.g. OOM) rejects; the slot is replaced.
 */
import type { PoolLike, Slot } from './pool'
import { JobCancelledError, type JobProgress, type Priority } from './types'

export interface SubmitOptions {
  priority?: Priority
  signal?: AbortSignal
  onProgress?: (p: JobProgress) => void
  /** Called when the job leaves the queue and starts on a worker. */
  onStart?: () => void
  /** Custom id (defaults to a random UUID). */
  jobId?: string
}

interface Pending<I, O> {
  jobId: string
  input: I
  priority: Priority
  opts: SubmitOptions
  resolve: (o: O) => void
  reject: (e: unknown) => void
  seq: number
}

let seqCounter = 0

export class JobQueue<I, O> {
  private waiting: Pending<I, O>[] = []
  private running = 0

  constructor(
    private readonly pool: PoolLike<I, O>,
    private readonly cancelGraceMs = 500,
  ) {}

  get pendingCount(): number {
    return this.waiting.length
  }

  get runningCount(): number {
    return this.running
  }

  submit(input: I, opts: SubmitOptions = {}): Promise<O> {
    return new Promise<O>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new JobCancelledError())
      const job: Pending<I, O> = {
        jobId: opts.jobId ?? crypto.randomUUID(),
        input,
        priority: opts.priority ?? 'batch',
        opts,
        resolve,
        reject,
        seq: seqCounter++,
      }
      opts.signal?.addEventListener('abort', () => {
        const i = this.waiting.indexOf(job)
        if (i !== -1) {
          this.waiting.splice(i, 1)
          reject(new JobCancelledError())
        }
      }, { once: true })
      this.waiting.push(job)
      this.waiting.sort((a, b) => rank(a.priority) - rank(b.priority) || a.seq - b.seq)
      this.pump()
    })
  }

  private pump(): void {
    while (this.waiting.length) {
      const slot = this.pool.acquire()
      if (!slot) return
      const job = this.waiting.shift()!
      void this.execute(slot, job)
    }
  }

  private async execute(slot: Slot<I, O>, job: Pending<I, O>): Promise<void> {
    this.running++
    job.opts.onStart?.()
    let settled = false
    let killed = false
    const onAbort = () => {
      if (settled) return
      slot.cancel(job.jobId).catch(() => {})
      setTimeout(() => {
        if (settled) return
        // Non-interruptible (or hung) job: hard stop.
        killed = true
        settled = true
        this.pool.kill(slot)
        this.running--
        job.reject(new JobCancelledError())
        this.pump()
      }, this.cancelGraceMs)
    }
    job.opts.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const out = await slot.run(job.jobId, job.input, p => job.opts.onProgress?.(p))
      if (settled) return
      settled = true
      job.opts.onProgress?.({ ratio: 1 })
      job.resolve(out)
    }
    catch (err) {
      if (settled) return
      settled = true
      if (err instanceof Error && err.name === 'WorkerCrashedError') {
        // A dead worker can't be reused: replace it.
        killed = true
        this.pool.kill(slot)
        this.running--
        this.pump()
      }
      job.reject(job.opts.signal?.aborted ? new JobCancelledError() : err)
    }
    finally {
      job.opts.signal?.removeEventListener('abort', onAbort)
      if (!killed) {
        this.running--
        this.pool.release(slot)
        this.pump()
      }
    }
  }
}

function rank(p: Priority): number {
  return p === 'interactive' ? 0 : 1
}

/**
 * A lazily-grown pool of identical workers wrapped with Comlink.
 * Idle workers are terminated after `idleMs` to give WASM memory back.
 */
import { proxy, releaseProxy, wrap, type Remote, type UnproxyOrClone } from 'comlink'
import type { ProgressFn, ToolWorkerApi } from './types'

export class WorkerCrashedError extends Error {
  override name = 'WorkerCrashedError'
}

/** What the queue needs from a pool; implemented by WorkerPool and by test fakes. */
export interface Slot<I, O> {
  readonly id: number
  run(jobId: string, input: I, onProgress: ProgressFn): Promise<O>
  cancel(jobId: string): Promise<void>
}

export interface PoolLike<I, O> {
  /** A free slot, spawning one if under capacity, or `null` when all are busy. */
  acquire(): Slot<I, O> | null
  release(slot: Slot<I, O>): void
  /** Hard-stop a slot (non-interruptible job). It is removed and respawned on demand. */
  kill(slot: Slot<I, O>): void
}

interface WorkerSlot<I, O> extends Slot<I, O> {
  worker: Worker
  remote: Remote<ToolWorkerApi<I, O>>
  busy: boolean
  idleTimer?: ReturnType<typeof setTimeout>
}

export class WorkerPool<I, O> implements PoolLike<I, O> {
  private slots: WorkerSlot<I, O>[] = []
  private nextId = 1

  constructor(
    private readonly createWorker: () => Worker,
    private readonly size: number,
    private readonly idleMs = 60_000,
  ) {}

  get capacity(): number {
    return this.size
  }

  acquire(): Slot<I, O> | null {
    let slot = this.slots.find(s => !s.busy)
    if (!slot && this.slots.length < this.size) slot = this.spawn()
    if (!slot) return null
    slot.busy = true
    if (slot.idleTimer) clearTimeout(slot.idleTimer)
    return slot
  }

  release(slot: Slot<I, O>): void {
    const s = this.slots.find(x => x.id === slot.id)
    if (!s) return
    s.busy = false
    s.idleTimer = setTimeout(() => this.remove(s), this.idleMs)
  }

  kill(slot: Slot<I, O>): void {
    const s = this.slots.find(x => x.id === slot.id)
    if (s) this.remove(s)
  }

  dispose(): void {
    for (const s of [...this.slots]) this.remove(s)
  }

  private spawn(): WorkerSlot<I, O> {
    const worker = this.createWorker()
    const remote = wrap<ToolWorkerApi<I, O>>(worker)
    // Comlink promises never settle if the worker dies (e.g. killed for OOM); race them against a crash signal.
    let crash: (e: Error) => void = () => {}
    const crashed = new Promise<never>((_, reject) => {
      crash = reject
    })
    crashed.catch(() => {})
    const onError = (ev: Event) => {
      const msg = ev instanceof ErrorEvent && ev.message ? ev.message : 'The worker stopped unexpectedly'
      crash(new WorkerCrashedError(msg))
    }
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onError)

    const slot: WorkerSlot<I, O> = {
      id: this.nextId++,
      worker,
      remote,
      busy: false,
      run: (jobId, input, onProgress) =>
        Promise.race([remote.run(jobId, input as UnproxyOrClone<I>, proxy(onProgress)) as Promise<O>, crashed]),
      cancel: jobId => remote.cancel(jobId) as Promise<void>,
    }
    this.slots.push(slot)
    return slot
  }

  private remove(s: WorkerSlot<I, O>): void {
    if (s.idleTimer) clearTimeout(s.idleTimer)
    try {
      s.remote[releaseProxy]()
    }
    catch { /* already released */ }
    s.worker.terminate()
    this.slots = this.slots.filter(x => x !== s)
  }
}

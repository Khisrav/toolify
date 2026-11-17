/**
 * Connects a tool's worker queue to the jobs store.
 *
 *   const runner = useJobRunner<StudioJobInput, StudioJobResult>('image-studio', {
 *     createWorker: () => new Worker(new URL('../tools/_image-engine/studio-worker.ts', import.meta.url), { type: 'module' }),
 *   })
 *   runner.submit(input, { label: file.name, bytesIn: file.size })
 *
 * One pool+queue per tool kind, shared across component instances and torn down when idle.
 * Heavy data (inputs, results) is kept in a plain Map, never in reactive state.
 */
import { poolSize } from '~/lib/capabilities'
import { WorkerPool } from '~/workers/pool'
import { JobQueue } from '~/workers/queue'
import { isCancelled, type Priority } from '~/workers/types'
import { useCapabilitiesStore } from '~/stores/capabilities'
import { useJobsStore } from '~/stores/jobs'

export interface JobRunnerOptions {
  createWorker: () => Worker
  /** Heavy tools (video, large WASM engines) get a single worker. */
  heavy?: boolean
}

interface Runtime<I, O> {
  pool: WorkerPool<I, O>
  queue: JobQueue<I, O>
  controllers: Map<string, AbortController>
  results: Map<string, O>
}

const runtimes = new Map<string, Runtime<unknown, unknown>>()

export function useJobRunner<I, O extends { path?: string; bytesOut?: number }>(tool: string, options: JobRunnerOptions) {
  const jobs = useJobsStore()
  const capsStore = useCapabilitiesStore()

  function runtime(): Runtime<I, O> {
    let rt = runtimes.get(tool) as Runtime<I, O> | undefined
    if (!rt) {
      const caps = capsStore.caps ?? { hardwareConcurrency: navigator.hardwareConcurrency || 2, deviceMemory: 4, isIOS: false }
      const pool = new WorkerPool<I, O>(options.createWorker, poolSize(caps, options.heavy))
      rt = { pool, queue: new JobQueue(pool), controllers: new Map(), results: new Map() }
      runtimes.set(tool, rt as Runtime<unknown, unknown>)
    }
    return rt
  }

  function submit(input: I, meta: { label: string; bytesIn?: number; priority?: Priority }): { id: string; done: Promise<O> } {
    const rt = runtime()
    const id = crypto.randomUUID()
    const controller = new AbortController()
    rt.controllers.set(id, controller)
    jobs.add({ id, tool, label: meta.label, bytesIn: meta.bytesIn })

    const done = rt.queue.submit(input, {
      jobId: id,
      priority: meta.priority,
      signal: controller.signal,
      onStart: () => jobs.update(id, { status: 'running' }),
      onProgress: p => jobs.update(id, { progress: p.ratio, phase: p.phase }),
    }).then((out) => {
      rt.results.set(id, out)
      jobs.update(id, { status: 'done', progress: 1, path: out.path, bytesOut: out.bytesOut })
      return out
    }, (err: unknown) => {
      const cancelled = isCancelled(err)
      jobs.update(id, {
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? undefined : describeError(err),
      })
      throw err
    }).finally(() => rt.controllers.delete(id))

    done.catch(() => {}) // callers may ignore the promise; state lives in the store
    return { id, done }
  }

  function cancel(id: string) {
    runtimes.get(tool)?.controllers.get(id)?.abort()
  }

  function cancelAll() {
    for (const c of runtimes.get(tool)?.controllers.values() ?? []) c.abort()
  }

  function result(id: string): O | undefined {
    return (runtimes.get(tool) as Runtime<I, O> | undefined)?.results.get(id)
  }

  function forget(id: string) {
    cancel(id)
    runtimes.get(tool)?.results.delete(id)
    jobs.remove(id)
  }

  function clear() {
    cancelAll()
    runtimes.get(tool)?.results.clear()
    jobs.clearTool(tool)
  }

  return {
    submit,
    cancel,
    cancelAll,
    result,
    forget,
    clear,
    jobs: computed(() => jobs.byTool(tool)),
  }
}

export function describeError(err: unknown): string {
  if (err instanceof RangeError || (err instanceof Error && /memory|allocation/i.test(err.message))) {
    return 'This file is too large for this device. Try resizing it first.'
  }
  if (err instanceof Error && err.name === 'WorkerCrashedError') {
    return 'Processing stopped unexpectedly (the device may have run out of memory).'
  }
  return err instanceof Error ? err.message : String(err)
}

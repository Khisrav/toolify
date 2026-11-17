/**
 * Worker-side helper: turns a plain async handler into a cancellable, progress-reporting
 * Comlink API. Import only from inside a worker module.
 */
import { expose } from 'comlink'
import type { JobProgress, ProgressFn, ToolWorkerApi } from './types'

export interface JobContext {
  jobId: string
  signal: AbortSignal
  /** Throttled to ~10 updates/s; the final 1.0 is always delivered. */
  progress: ProgressFn
}

export type JobHandler<I, O> = (input: I, ctx: JobContext) => Promise<O>

export function throttleProgress(fn: ProgressFn, intervalMs = 100): ProgressFn {
  let last = 0
  return (p: JobProgress) => {
    const now = Date.now()
    if (p.ratio >= 1 || now - last >= intervalMs) {
      last = now
      fn(p)
    }
  }
}

export function createToolApi<I, O>(handler: JobHandler<I, O>): ToolWorkerApi<I, O> {
  const controllers = new Map<string, AbortController>()
  return {
    async run(jobId, input, onProgress) {
      const controller = new AbortController()
      controllers.set(jobId, controller)
      try {
        return await handler(input, { jobId, signal: controller.signal, progress: throttleProgress(onProgress) })
      }
      finally {
        controllers.delete(jobId)
      }
    },
    async cancel(jobId) {
      controllers.get(jobId)?.abort()
    },
  }
}

export function exposeTool<I, O>(handler: JobHandler<I, O>): void {
  expose(createToolApi(handler))
}

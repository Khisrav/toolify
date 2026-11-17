export type Priority = 'interactive' | 'batch'

export interface JobProgress {
  /** 0..1 */
  ratio: number
  phase?: string
}

export type ProgressFn = (p: JobProgress) => void

/** The API every tool worker exposes over Comlink. */
export interface ToolWorkerApi<I, O> {
  run(jobId: string, input: I, onProgress: ProgressFn): Promise<O>
  /** Cooperative cancel. The queue terminates the worker if this does not settle the job quickly. */
  cancel(jobId: string): Promise<void>
}

export class JobCancelledError extends Error {
  override name = 'JobCancelledError'
  constructor() {
    super('The job was cancelled')
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof Error && (err.name === 'JobCancelledError' || err.name === 'AbortError')
}

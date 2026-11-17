import { defineStore } from 'pinia'

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/** Display metadata only. Files and results live in non-reactive maps (see useJobRunner). */
export interface JobMeta {
  id: string
  tool: string
  label: string
  status: JobStatus
  progress: number
  phase?: string
  /** Processing path actually used, e.g. 'native' | 'wasm' | 'wasm-mt'. */
  path?: string
  bytesIn?: number
  bytesOut?: number
  error?: string
  createdAt: number
}

export const useJobsStore = defineStore('jobs', () => {
  const jobs = ref<Record<string, JobMeta>>({})

  const list = computed(() => Object.values(jobs.value).sort((a, b) => a.createdAt - b.createdAt))
  const active = computed(() => list.value.filter(j => j.status === 'queued' || j.status === 'running'))
  const busy = computed(() => active.value.length > 0)

  function add(meta: Omit<JobMeta, 'status' | 'progress' | 'createdAt'>): JobMeta {
    const job: JobMeta = { ...meta, status: 'queued', progress: 0, createdAt: Date.now() }
    jobs.value[job.id] = job
    return job
  }

  function update(id: string, patch: Partial<JobMeta>) {
    const j = jobs.value[id]
    if (j) Object.assign(j, patch)
  }

  function remove(id: string) {
    jobs.value = Object.fromEntries(Object.entries(jobs.value).filter(([k]) => k !== id))
  }

  function clearTool(tool: string) {
    jobs.value = Object.fromEntries(Object.entries(jobs.value).filter(([, j]) => j.tool !== tool))
  }

  function byTool(tool: string) {
    return list.value.filter(j => j.tool === tool)
  }

  return { jobs, list, active, busy, add, update, remove, clearTool, byTool }
})

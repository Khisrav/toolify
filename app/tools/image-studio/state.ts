/**
 * Studio queue kept at module level, so it survives navigating away and back (jobs keep running
 * in the shared worker pool meanwhile).
 */
import { shallowRef } from 'vue'

export interface StudioItem {
  id: string
  file: File
  /** Folder-relative path, used for output names and the ZIP layout. */
  path: string
  jobId?: string
  /** Settings snapshot (JSON) the job ran with; differs from the current one → stale. */
  runKey?: string
}

export const studioItems = shallowRef<StudioItem[]>([])

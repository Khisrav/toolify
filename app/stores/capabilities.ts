import { defineStore } from 'pinia'
import { detectCapabilities, type Capabilities } from '~/lib/capabilities'

/** Probed once per session on the client. Not persisted. */
export const useCapabilitiesStore = defineStore('capabilities', () => {
  const caps = shallowRef<Capabilities | null>(null)
  let pending: Promise<Capabilities> | null = null

  function probe(): Promise<Capabilities> {
    if (import.meta.server) return Promise.reject(new Error('Capabilities are client-only'))
    pending ??= detectCapabilities().then((c) => {
      caps.value = c
      return c
    })
    return pending
  }

  return { caps, probe }
})

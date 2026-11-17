import { defineStore } from 'pinia'

export type EnginePreference = 'auto' | 'native' | 'wasm'

/** App-wide user preferences. Persisted to localStorage (see plugins/persist.client.ts). */
export const useSettingsStore = defineStore('settings', () => {
  /** Automatically download each result when its job finishes. */
  const autoDownload = ref(false)
  /** Keep EXIF metadata where supported (off by default for privacy). */
  const keepMetadata = ref(false)
  /** Debug override for the processing path ("path in use" badge). */
  const enginePreference = ref<EnginePreference>('auto')
  /** Slugs of recently used tools, most recent first. */
  const recentTools = ref<string[]>([])

  function touchTool(slug: string) {
    recentTools.value = [slug, ...recentTools.value.filter(s => s !== slug)].slice(0, 6)
  }

  function $reset() {
    autoDownload.value = false
    keepMetadata.value = false
    enginePreference.value = 'auto'
    recentTools.value = []
  }

  return { autoDownload, keepMetadata, enginePreference, recentTools, touchTool, $reset }
}, {
  persist: { key: 'toolify:settings' },
})

<script setup lang="ts">
const props = defineProps<{ path?: string }>()

const store = useCapabilitiesStore()
onMounted(() => { store.probe().catch(() => {}) })

const labels: Record<string, { label: string; icon: string }> = {
  'native': { label: 'Native', icon: 'i-lucide-zap' },
  'webcodecs': { label: 'Hardware accelerated', icon: 'i-lucide-zap' },
  'wasm': { label: 'WASM', icon: 'i-lucide-cpu' },
  'wasm-mt': { label: 'Multithreaded WASM', icon: 'i-lucide-cpu' },
  'ffmpeg-mt': { label: 'Multithreaded FFmpeg', icon: 'i-lucide-cpu' },
  'ffmpeg-st': { label: 'Compatibility mode', icon: 'i-lucide-turtle' },
}

const caps = computed(() => store.caps)
const entry = computed(() => (props.path ? labels[props.path] ?? { label: props.path, icon: 'i-lucide-cpu' } : null))
const summary = computed(() => {
  const c = caps.value
  if (!c) return 'Probing this device…'
  const enc = Object.entries(c.nativeEncode).filter(([, ok]) => ok).map(([k]) => k.toUpperCase())
  return [
    `Cross-origin isolated: ${c.crossOriginIsolated ? 'yes' : 'no'}`,
    `Threads: ${c.hardwareConcurrency}`,
    `Native encoders: ${enc.length ? enc.join(', ') : 'none'}`,
  ].join(' · ')
})
const deviceLabel = computed(() => caps.value
  ? `Device: ${caps.value.hardwareConcurrency} threads · isolated ${caps.value.crossOriginIsolated ? '✓' : '✗'}`
  : 'Device: checking…')
</script>

<template>
  <UTooltip :text="summary">
    <UBadge
      :label="entry ? entry.label : deviceLabel"
      :icon="entry ? entry.icon : 'i-lucide-cpu'"
      color="neutral"
      variant="subtle"
      tabindex="0"
    />
  </UTooltip>
</template>

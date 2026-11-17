<script setup lang="ts">
const props = withDefaults(defineProps<{
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  label?: string
}>(), { beforeLabel: 'Before', afterLabel: 'After', label: 'Compare before and after' })

/** Percentage of the width showing the "before" image. */
const pos = ref(50)
const clip = computed(() => `inset(0 ${100 - pos.value}% 0 0)`)
</script>

<template>
  <div class="relative isolate focus-within:ring-2 focus-within:ring-primary w-full select-none overflow-hidden rounded-lg border border-default bg-elevated touch-pan-y">
    <img :src="props.after" :alt="props.afterLabel" class="block w-full h-auto" draggable="false">
    <img
      :src="props.before"
      :alt="props.beforeLabel"
      class="absolute inset-0 size-full object-contain"
      draggable="false"
      :style="{ clipPath: clip }"
    >
    <span class="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 text-xs text-white">{{ props.beforeLabel }}</span>
    <span class="pointer-events-none absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-xs text-white">{{ props.afterLabel }}</span>
    <div class="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow" :style="{ left: `${pos}%` }">
      <span class="absolute top-1/2 left-1/2 grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-black shadow">
        <UIcon name="i-lucide-chevrons-left-right" class="size-5" />
      </span>
    </div>
    <input
      v-model.number="pos"
      type="range"
      min="0"
      max="100"
      step="1"
      :aria-label="props.label"
      :aria-valuetext="`${pos}% ${props.beforeLabel}, ${100 - pos}% ${props.afterLabel}`"
      class="absolute inset-0 size-full cursor-ew-resize opacity-0"
    >
  </div>
</template>

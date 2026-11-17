<script setup lang="ts">
const jobs = useJobsStore()
const text = computed(() => jobs.busy ? `Working on ${jobs.active.length} ${jobs.active.length === 1 ? 'file' : 'files'}` : '')

// Warn before closing the tab while work is running.
if (import.meta.client) {
  useEventListener(window, 'beforeunload', (e) => {
    if (jobs.busy) e.preventDefault()
  })
}
</script>

<template>
  <div role="status" aria-live="polite" :class="jobs.busy ? 'fixed right-3 top-3 z-50 pt-safe' : 'sr-only'">
    <UBadge
      v-if="jobs.busy"
      color="primary"
      variant="solid"
      icon="i-lucide-loader-circle"
      :ui="{ leadingIcon: 'animate-spin motion-reduce:animate-none' }"
      :label="text"
    />
  </div>
</template>

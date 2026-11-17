<script setup lang="ts">
const { $pwa } = useNuxtApp()
const jobs = useJobsStore()
const toast = useToast()

watch(() => $pwa?.offlineReady, (ready) => {
  if (!ready) return
  toast.add({ title: 'Ready to work offline', icon: 'i-lucide-circle-check', color: 'success' })
  $pwa?.cancelPrompt()
}, { immediate: true })

const open = computed(() => !!$pwa?.needRefresh)
</script>

<template>
  <div
    v-if="open"
    role="alert"
    class="fixed inset-x-3 bottom-20 z-50 mx-auto flex max-w-md items-center gap-3 rounded-lg border border-default bg-default p-3 shadow-lg lg:inset-x-auto lg:right-4 lg:bottom-4"
  >
    <UIcon name="i-lucide-refresh-cw" class="size-5 shrink-0 text-primary" />
    <p class="min-w-0 flex-1 text-sm">
      {{ jobs.busy ? 'Update available — finish current work to reload' : 'Update available' }}
    </p>
    <UButton label="Reload" size="sm" :disabled="jobs.busy" @click="$pwa?.updateServiceWorker(true)" />
    <UButton icon="i-lucide-x" size="sm" color="neutral" variant="ghost" aria-label="Dismiss update notice" @click="$pwa?.cancelPrompt()" />
  </div>
</template>

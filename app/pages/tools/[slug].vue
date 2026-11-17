<script setup lang="ts">
import { findTool } from '~/tools/meta'
import { toolLoaders } from '~/tools/registry'

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const tool = computed(() => findTool(slug.value))

if (!tool.value || tool.value.status !== 'available' || !toolLoaders[slug.value]) {
  throw createError({ statusCode: 404, statusMessage: 'Tool not found', fatal: true })
}

useSeoMeta({
  title: () => `${tool.value!.title} · Toolify`,
  description: () => `${tool.value!.description} Runs entirely in your browser — files never leave your device.`,
})

const ToolComponent = defineAsyncComponent(toolLoaders[slug.value]!)

if (import.meta.client) useSettingsStore().touchTool(slug.value)
</script>

<template>
  <ClientOnly>
    <ToolComponent :meta="tool!" />
    <template #fallback>
      <div class="space-y-4 p-4 sm:p-6" aria-busy="true">
        <USkeleton class="h-8 w-56" />
        <USkeleton class="h-48 w-full" />
      </div>
    </template>
  </ClientOnly>
</template>

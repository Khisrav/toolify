<script setup lang="ts">
import { tools, categories, findTool, type ToolMeta } from '~/tools/meta'

useSeoMeta({
  title: 'Toolify — private file tools',
  description: 'Convert, compress and resize files right in your browser. Nothing is uploaded.',
})

const settings = useSettingsStore()
const category = ref('all')
const query = ref('')

const tabs = [{ label: 'All', value: 'all' }, ...categories.map(c => ({ label: c.label, value: c.id }))]

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return tools.filter((t) => {
    if (category.value !== 'all' && t.category !== category.value) return false
    if (!q) return true
    return [t.title, t.description, ...t.keywords].some(s => s.toLowerCase().includes(q))
  })
})
const recent = computed(() => settings.recentTools.map(findTool).filter((t): t is ToolMeta => !!t && t.status === 'available'))
</script>

<template>
  <div class="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
    <section class="space-y-2">
      <h1 class="text-2xl font-semibold tracking-tight sm:text-4xl">Everything stays on your device.</h1>
      <p class="text-muted">
        Files are processed locally in your browser and never uploaded.
        <ULink to="/privacy" class="text-primary underline underline-offset-2">How it works</ULink>
      </p>
    </section>

    <ClientOnly>
      <section v-if="recent.length" aria-labelledby="recent-h" class="space-y-2">
        <h2 id="recent-h" class="text-sm font-medium text-muted">Recent</h2>
        <ul class="flex flex-wrap gap-2">
          <li v-for="t in recent" :key="t.slug">
            <UButton :to="`/tools/${t.slug}`" :icon="t.icon" :label="t.title" color="neutral" variant="outline" />
          </li>
        </ul>
      </section>
    </ClientOnly>

    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <UTabs v-model="category" :items="tabs" variant="pill" :content="false" class="w-full sm:w-auto" :ui="{ list: 'overflow-x-auto', trigger: 'shrink-0' }" />
      <UInput
        v-model="query"
        icon="i-lucide-search"
        placeholder="Filter tools…"
        aria-label="Filter tools"
        class="w-full sm:w-64"
      />
    </div>

    <UPageGrid v-if="filtered.length" class="lg:grid-cols-3">
      <UPageCard
        v-for="t in filtered"
        :key="t.slug"
        :icon="t.icon"
        :title="t.title"
        :description="t.description"
        :to="t.status === 'available' ? `/tools/${t.slug}` : undefined"
        :class="t.status === 'soon' ? 'opacity-70' : ''"
        :aria-disabled="t.status === 'soon' ? 'true' : undefined"
      >
        <UBadge v-if="t.status === 'soon'" label="Coming soon" color="neutral" variant="subtle" class="w-fit" />
        <UBadge v-else label="Works offline" color="success" variant="subtle" class="w-fit" />
      </UPageCard>
    </UPageGrid>
    <p v-else class="py-10 text-center text-muted">No tools match your filter.</p>
  </div>
</template>

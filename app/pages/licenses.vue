<script setup lang="ts">
import licenses from '~/lib/licenses.json'

useSeoMeta({ title: 'Licenses · Toolify' })

interface LicenseEntry {
  name: string
  version: string
  license: string
}

const all = licenses as LicenseEntry[]
const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return all
  return all.filter(l =>
    l.name.toLowerCase().includes(q) || l.license.toLowerCase().includes(q),
  )
})
</script>

<template>
  <UContainer class="max-w-3xl space-y-6 py-8">
    <section class="space-y-2">
      <h1 class="text-2xl font-semibold">
        Open-source licenses
      </h1>
      <p class="text-muted">
        Toolify is built on open-source software. The packages below are included in the app.
      </p>
      <p class="text-sm text-muted" role="status">
        {{ all.length }} packages
        <span v-if="filtered.length !== all.length">· {{ filtered.length }} shown</span>
      </p>
    </section>

    <UFormField label="Filter by name or license" name="license-filter">
      <UInput
        v-model="query"
        icon="i-lucide-search"
        placeholder="For example: MIT, nuxt, vue"
        aria-label="Filter packages by name or license"
        class="w-full"
      />
    </UFormField>

    <div class="overflow-x-auto rounded-lg border border-default">
      <table class="w-full text-left text-sm">
        <caption class="sr-only">
          Open-source packages used by Toolify, with version and license
        </caption>
        <thead class="bg-elevated text-muted">
          <tr>
            <th scope="col" class="px-3 py-2 font-medium">
              Package
            </th>
            <th scope="col" class="px-3 py-2 font-medium">
              Version
            </th>
            <th scope="col" class="px-3 py-2 font-medium">
              License
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="entry in filtered" :key="`${entry.name}@${entry.version}`">
            <td class="break-all px-3 py-2 font-medium">
              {{ entry.name }}
            </td>
            <td class="whitespace-nowrap px-3 py-2 tabular-nums">
              {{ entry.version }}
            </td>
            <td class="px-3 py-2">
              {{ entry.license }}
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="3" class="px-3 py-6 text-center text-muted">
              No packages match “{{ query }}”.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </UContainer>
</template>

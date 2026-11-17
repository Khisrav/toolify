<script setup lang="ts">
import { tools, categories } from '~/tools/meta'

const open = defineModel<boolean>('open', { default: false })
const router = useRouter()

const groups = computed(() => [
  ...categories.map(cat => ({
    id: cat.id,
    label: cat.label,
    items: tools.filter(t => t.category === cat.id).map(t => ({
      id: t.slug,
      label: t.title,
      description: t.status === 'soon' ? `Coming soon · ${t.description}` : t.description,
      suffix: t.keywords.join(' '),
      icon: t.icon,
      disabled: t.status === 'soon',
      onSelect: () => { router.push(`/tools/${t.slug}`) },
    })),
  })),
  {
    id: 'pages',
    label: 'Pages',
    items: [
      { id: 'home', label: 'Home', icon: 'i-lucide-house', onSelect: () => { router.push('/') } },
      { id: 'settings', label: 'Settings', icon: 'i-lucide-settings', onSelect: () => { router.push('/settings') } },
      { id: 'privacy', label: 'Privacy', icon: 'i-lucide-shield-check', onSelect: () => { router.push('/privacy') } },
      { id: 'about', label: 'About', icon: 'i-lucide-info', onSelect: () => { router.push('/about') } },
    ],
  },
])

defineShortcuts({
  '/': { usingInput: false, handler: () => { open.value = true } },
})
</script>

<template>
  <UDashboardSearch
    v-model:open="open"
    :groups="groups"
    :color-mode="false"
    placeholder="Search tools…"
    title="Search tools"
    description="Find a tool by name or keyword"
  />
</template>

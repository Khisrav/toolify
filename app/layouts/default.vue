<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { tools, categories } from '~/tools/meta'

// One responsive structure (no JS breakpoint): the sidebar is CSS-hidden below `lg`,
// where the bottom nav takes over. Avoids a phone→desktop swap after hydration.
const searchOpen = ref(false)
const route = useRoute()

const nav = computed<NavigationMenuItem[][]>(() => [
  [{ label: 'Home', icon: 'i-lucide-house', to: '/', exact: true }],
  ...categories.map(cat => [
    { label: cat.label, type: 'label' as const },
    ...tools.filter(t => t.category === cat.id).map((t): NavigationMenuItem => t.status === 'available'
      ? { label: t.title, icon: t.icon, to: `/tools/${t.slug}` }
      : { label: t.title, icon: t.icon, disabled: true, badge: 'Soon' }),
  ]),
  [
    { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' },
    { label: 'Privacy', icon: 'i-lucide-shield-check', to: '/privacy' },
    { label: 'About', icon: 'i-lucide-info', to: '/about' },
  ],
])

const title = computed(() => {
  if (route.path === '/') return 'Toolify'
  const slug = route.path.startsWith('/tools/') ? route.path.slice(7) : ''
  return tools.find(t => t.slug === slug)?.title ?? ''
})
</script>

<template>
  <div>
    <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:rounded focus:bg-default focus:p-2">Skip to content</a>
    <ShellToolSearch v-model:open="searchOpen" />
    <ShellBusyIndicator />
    <ShellPwaPrompt />

    <UDashboardGroup storage="local" storage-key="toolify-dashboard">
      <UDashboardSidebar collapsible resizable :min-size="14" :default-size="18" :collapsed-size="4" :toggle="false" :ui="{ footer: 'border-t border-default' }">
        <template #header="{ collapsed }">
          <NuxtLink to="/" class="flex min-h-11 items-center gap-2 font-semibold" aria-label="Toolify home">
            <UIcon name="i-lucide-wrench" class="size-6 shrink-0 text-primary" />
            <span v-if="!collapsed">Toolify</span>
          </NuxtLink>
        </template>
        <template #default="{ collapsed }">
          <UDashboardSearchButton :collapsed="collapsed" label="Search tools…" :kbds="['/']" @click="searchOpen = true" />
          <UNavigationMenu :items="nav" orientation="vertical" :collapsed="collapsed" tooltip aria-label="Tools" />
        </template>
        <template #footer="{ collapsed }">
          <ShellCapabilityBadge v-if="!collapsed" />
        </template>
      </UDashboardSidebar>

      <UDashboardPanel :ui="{ body: 'p-0 sm:p-0 pb-24 lg:pb-0' }">
        <template #header>
          <UDashboardNavbar :toggle="false" :ui="{ root: 'pt-safe' }">
            <template #left>
              <NuxtLink to="/" class="flex min-h-11 items-center gap-2 font-semibold lg:hidden" aria-label="Toolify home">
                <UIcon name="i-lucide-wrench" class="size-6 text-primary" />
              </NuxtLink>
              <span class="truncate font-semibold">{{ title }}</span>
            </template>
            <template #right>
              <ShellPrivacyBadge />
              <UButton class="lg:hidden" icon="i-lucide-search" color="neutral" variant="ghost" aria-label="Search tools" @click="searchOpen = true" />
              <UColorModeButton aria-label="Toggle colour mode" />
            </template>
          </UDashboardNavbar>
        </template>
        <template #body>
          <main id="main" tabindex="-1" class="min-w-0 outline-none"><slot /></main>
        </template>
      </UDashboardPanel>
    </UDashboardGroup>

    <ShellAppBottomNav />
  </div>
</template>

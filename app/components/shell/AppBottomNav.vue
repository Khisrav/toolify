<script setup lang="ts">
import { tools, categories } from '~/tools/meta'

const route = useRoute()
const moreOpen = ref(false)
watch(() => route.fullPath, () => { moreOpen.value = false })

const items = [
  { to: '/', label: 'Home', icon: 'i-lucide-house', active: () => route.path === '/' },
  { to: '/tools/image-studio', label: 'Images', icon: 'i-lucide-image', active: () => route.path.startsWith('/tools/image') },
  { to: '/settings', label: 'Settings', icon: 'i-lucide-settings', active: () => route.path === '/settings' },
]
const pages = [
  { to: '/privacy', label: 'Privacy', icon: 'i-lucide-shield-check' },
  { to: '/about', label: 'About', icon: 'i-lucide-info' },
  { to: '/licenses', label: 'Licenses', icon: 'i-lucide-scale' },
]
const linkClass = 'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs text-muted hover:text-default'
</script>

<template>
  <nav aria-label="Primary" class="fixed inset-x-0 bottom-0 z-40 flex lg:hidden border-t border-default bg-default/95 backdrop-blur pb-safe">
    <NuxtLink
      v-for="i in items"
      :key="i.to"
      :to="i.to"
      :class="[linkClass, i.active() && 'text-primary font-medium']"
      :aria-current="i.active() ? 'page' : undefined"
    >
      <UIcon :name="i.icon" class="size-6" />
      {{ i.label }}
    </NuxtLink>
    <button type="button" :class="linkClass" aria-haspopup="dialog" :aria-expanded="moreOpen" @click="moreOpen = true">
      <UIcon name="i-lucide-ellipsis" class="size-6" />
      More
    </button>
  </nav>

  <UDrawer v-model:open="moreOpen" title="All tools" description="Browse every tool and page">
    <template #body>
      <div class="max-h-[70dvh] overflow-y-auto pb-safe">
        <section v-for="cat in categories" :key="cat.id" class="mb-4">
          <h3 class="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted">{{ cat.label }}</h3>
          <ul>
            <li v-for="t in tools.filter(x => x.category === cat.id)" :key="t.slug">
              <NuxtLink
                v-if="t.status === 'available'"
                :to="`/tools/${t.slug}`"
                class="flex min-h-11 items-center gap-3 rounded-md px-2 hover:bg-elevated"
                :aria-current="route.path === `/tools/${t.slug}` ? 'page' : undefined"
              >
                <UIcon :name="t.icon" class="size-5 text-primary" />{{ t.title }}
              </NuxtLink>
              <span v-else class="flex min-h-11 items-center gap-3 px-2 text-muted" aria-disabled="true">
                <UIcon :name="t.icon" class="size-5" />{{ t.title }}
                <UBadge label="Soon" size="sm" color="neutral" variant="subtle" />
              </span>
            </li>
          </ul>
        </section>
        <section>
          <h3 class="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted">Pages</h3>
          <ul>
            <li v-for="p in pages" :key="p.to">
              <NuxtLink :to="p.to" class="flex min-h-11 items-center gap-3 rounded-md px-2 hover:bg-elevated">
                <UIcon :name="p.icon" class="size-5" />{{ p.label }}
              </NuxtLink>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </UDrawer>
</template>

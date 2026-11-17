<script setup lang="ts">
import { tools } from '~/tools/meta'

useSeoMeta({ title: 'About · Toolify' })

const available = tools.filter(t => t.status === 'available')
const upcoming = tools.filter(t => t.status === 'soon')

const stack = [
  { name: 'Nuxt', detail: 'App framework, prerendered as static files.' },
  { name: 'Nuxt UI', detail: 'Interface components and styling.' },
  { name: 'jSquash', detail: 'WebAssembly image codecs for JPEG and WebP.' },
  { name: 'Web Workers', detail: 'Run heavy processing off the main thread.' },
]
</script>

<template>
  <UContainer class="max-w-3xl space-y-8 py-8">
    <section class="space-y-3">
      <h1 class="text-2xl font-semibold">
        About Toolify
      </h1>
      <p class="text-muted">
        Toolify is a collection of everyday file tools that run entirely in your browser. Your files are processed on your device, nothing is uploaded, and there are no accounts or trackers. For details, read the <NuxtLink to="/privacy" class="underline">privacy page</NuxtLink>.
      </p>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-semibold">
        Available tools
      </h2>
      <ul class="grid gap-3 sm:grid-cols-2">
        <li v-for="tool in available" :key="tool.slug">
          <UCard>
            <div class="flex items-start gap-3">
              <UIcon :name="tool.icon" class="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <div class="space-y-1">
                <p class="font-medium">
                  {{ tool.title }}
                </p>
                <p class="text-sm text-muted">
                  {{ tool.description }}
                </p>
              </div>
            </div>
          </UCard>
        </li>
      </ul>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-semibold">
        Coming soon
      </h2>
      <ul class="grid gap-3 sm:grid-cols-2">
        <li v-for="tool in upcoming" :key="tool.slug">
          <UCard>
            <div class="flex items-start gap-3">
              <UIcon :name="tool.icon" class="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
              <div class="space-y-1">
                <p class="flex flex-wrap items-center gap-2 font-medium">
                  {{ tool.title }}
                  <UBadge label="Coming soon" color="neutral" variant="subtle" size="sm" />
                </p>
                <p class="text-sm text-muted">
                  {{ tool.description }}
                </p>
              </div>
            </div>
          </UCard>
        </li>
      </ul>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-semibold">
        Built with
      </h2>
      <ul class="space-y-2">
        <li v-for="item in stack" :key="item.name" class="text-sm">
          <span class="font-medium">{{ item.name }}</span>: {{ item.detail }}
        </li>
      </ul>
    </section>

    <section class="space-y-2">
      <h2 class="text-lg font-semibold">
        Open-source licenses
      </h2>
      <p class="text-sm text-muted">
        Toolify is built on open-source software. See the full list of packages and their licenses on the <NuxtLink to="/licenses" class="underline">licenses page</NuxtLink>.
      </p>
    </section>
  </UContainer>
</template>

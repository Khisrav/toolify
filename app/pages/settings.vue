<script setup lang="ts">
import { storeToRefs } from 'pinia'
import type { EnginePreference } from '~/stores/settings'

useSeoMeta({ title: 'Settings · Toolify' })

const store = useSettingsStore()
const { autoDownload, keepMetadata, enginePreference } = storeToRefs(store)

const engineItems: { label: string, value: EnginePreference }[] = [
  { label: 'Auto', value: 'auto' },
  { label: 'Native only', value: 'native' },
  { label: 'WASM only', value: 'wasm' },
]

const MB = 1024 * 1024

const usage = ref<number | null>(null)
const quota = ref<number | null>(null)
const persisted = ref<boolean | null>(null)
const persistMessage = ref('')
const cacheMessage = ref('')
const clearing = ref(false)
const requesting = ref(false)

function formatMB(bytes: number | null): string {
  return bytes === null ? 'unknown' : `${(bytes / MB).toFixed(1)} MB`
}

async function refreshEstimate() {
  try {
    const estimate = await navigator.storage.estimate()
    usage.value = estimate.usage ?? null
    quota.value = estimate.quota ?? null
  }
  catch {
    usage.value = null
    quota.value = null
  }
}

async function refreshPersisted() {
  try {
    persisted.value = await navigator.storage.persisted()
  }
  catch {
    persisted.value = null
  }
}

async function requestPersistence() {
  requesting.value = true
  persistMessage.value = ''
  try {
    const granted = await navigator.storage.persist()
    persisted.value = granted
    persistMessage.value = granted
      ? 'Granted. The browser should keep Toolify’s cached data.'
      : 'Not granted. The browser may clear cached data when storage runs low.'
  }
  catch {
    persistMessage.value = 'Persistent storage is not available in this browser.'
  }
  finally {
    requesting.value = false
  }
}

async function clearEngineCaches() {
  clearing.value = true
  cacheMessage.value = ''
  try {
    const names = (await caches.keys()).filter(name => name.startsWith('toolify-'))
    await Promise.all(names.map(name => caches.delete(name)))
    cacheMessage.value = names.length
      ? `Cleared ${names.length} cache${names.length === 1 ? '' : 's'}. Engines will be downloaded again when next needed.`
      : 'No cached engines found.'
    await refreshEstimate()
  }
  catch {
    cacheMessage.value = 'Could not clear the cache in this browser.'
  }
  finally {
    clearing.value = false
  }
}

function resetSettings() {
  store.$reset()
}

onMounted(() => {
  refreshEstimate()
  refreshPersisted()
})
</script>

<template>
  <UContainer class="max-w-2xl space-y-6 py-8">
    <h1 class="text-2xl font-semibold">
      Settings
    </h1>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          Appearance
        </h2>
      </template>
      <UFormField label="Theme" name="color-mode">
        <UColorModeSelect />
      </UFormField>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          Processing
        </h2>
      </template>
      <div class="space-y-5">
        <USwitch
          v-model="autoDownload"
          label="Download automatically"
          description="Save each result as soon as its job finishes."
        />
        <USwitch
          v-model="keepMetadata"
          label="Keep metadata"
          description="Keep EXIF data where supported. Off by default for privacy."
        />
        <UFormField
          label="Processing engine"
          name="engine-preference"
          help="Used for troubleshooting. Leave on Auto unless told otherwise."
        >
          <USelect
            v-model="enginePreference"
            :items="engineItems"
            value-key="value"
            label-key="label"
            class="w-full"
            aria-label="Processing engine"
          />
        </UFormField>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          Storage
        </h2>
      </template>
      <ClientOnly>
        <div class="space-y-5">
          <p class="text-sm">
            Browser storage used by Toolify:
            <span class="font-medium">{{ formatMB(usage) }}</span>
            of
            <span class="font-medium">{{ formatMB(quota) }}</span>
            available.
          </p>

          <div class="space-y-2">
            <p class="text-sm text-muted">
              Persistent storage:
              <span class="font-medium">{{ persisted === null ? 'unknown' : persisted ? 'granted' : 'not granted' }}</span>
            </p>
            <UButton
              label="Request persistent storage"
              icon="i-lucide-shield-check"
              variant="outline"
              color="neutral"
              :loading="requesting"
              @click="requestPersistence"
            />
            <p v-if="persistMessage" role="status" class="text-sm text-muted">
              {{ persistMessage }}
            </p>
          </div>

          <div class="space-y-2">
            <p class="text-sm text-muted">
              Processing engines are cached on this device after first use.
            </p>
            <UButton
              label="Clear cached engines"
              icon="i-lucide-trash-2"
              variant="outline"
              color="neutral"
              :loading="clearing"
              @click="clearEngineCaches"
            />
            <p v-if="cacheMessage" role="status" class="text-sm text-muted">
              {{ cacheMessage }}
            </p>
          </div>
        </div>
        <template #fallback>
          <p class="text-sm text-muted">
            Loading storage details…
          </p>
        </template>
      </ClientOnly>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          Reset settings
        </h2>
      </template>
      <div class="space-y-3">
        <p class="text-sm text-muted">
          Restore every setting on this page to its default value. Your files are never stored, so nothing else is affected.
        </p>
        <UButton
          label="Reset settings"
          icon="i-lucide-rotate-ccw"
          color="error"
          variant="soft"
          @click="resetSettings"
        />
      </div>
    </UCard>
  </UContainer>
</template>

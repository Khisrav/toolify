<script setup lang="ts">
/**
 * File intake for tools. Wraps UFileUpload for the click-to-choose dialog and uses
 * useFileInput for drops (incl. folders), paste and launch-queue. Nothing is uploaded.
 */
import { useMediaQuery } from '@vueuse/core'
import { describeAccept } from '~/lib/files'

const props = withDefaults(defineProps<{
  accept?: string[]
  multiple?: boolean
  label?: string
  description?: string
}>(), {
  accept: () => [],
  multiple: true,
  label: 'Drop files here',
  description: undefined,
})

const emit = defineEmits<{ files: [files: File[]] }>()

const root = ref<HTMLElement | null>(null)
const id = useId()
const formatsId = `${id}-formats`
const hintId = `${id}-hint`

const { add, rejected, isOverDropZone } = useFileInput({
  accept: () => props.accept,
  multiple: () => props.multiple,
  dropZone: root,
  onAdded: added => emit('files', added),
})
// The composable also keeps its own list; the parent owns the files via the `files` event.

const finePointer = useMediaQuery('(pointer: fine)')
const mounted = ref(false)
onMounted(() => { mounted.value = true })
const showDesktopHint = computed(() => mounted.value && finePointer.value)

const formats = computed(() => describeAccept(props.accept))
const acceptAttr = computed(() => props.accept.join(',') || undefined)

// UFileUpload's v-model is only a transport: forward chosen files, then clear it so
// the component never renders its own file list.
const model = ref<File | File[] | null>(null)
function onChosen(value: File | File[] | null | undefined) {
  if (!value) return
  add(Array.isArray(value) ? value : [value])
  model.value = null
}
// UFileUpload applies the native `accept` filter itself; surface what it blocked.
const nativeRejected = ref<string[]>([])
function onReject(list: File[]) {
  nativeRejected.value = list.map(f => f.name)
}

const messages = computed(() => [
  ...rejected.value.map(r => (r.name ? `${r.name}: ${r.reason}` : r.reason)),
  ...nativeRejected.value.map(n => `${n}: Unsupported file type`),
])
watch(rejected, () => { nativeRejected.value = [] })
</script>

<template>
  <div ref="root" class="space-y-3">
    <UFileUpload
      v-model="model"
      :multiple="multiple"
      :accept="acceptAttr"
      :dropzone="false"
      :highlight="isOverDropZone"
      :aria-describedby="`${formatsId} ${hintId}`"
      class="min-h-48 w-full"
      @update:model-value="onChosen"
      @reject="onReject"
    >
      <template #default="{ open }">
        <div class="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
          <UIcon :name="isOverDropZone ? 'i-lucide-folder-open' : 'i-lucide-upload'" class="size-8 text-muted" aria-hidden="true" />
          <p class="font-medium text-highlighted">
            {{ isOverDropZone ? 'Release to add' : label }}
          </p>
          <p v-if="description" class="text-sm text-muted">
            {{ description }}
          </p>
          <p :id="formatsId" class="text-xs text-muted">
            <template v-if="formats.length">
              Accepts: {{ formats.join(', ') }}
            </template>
            <template v-else>
              Accepts any file
            </template>
          </p>
          <p :id="hintId" class="text-xs text-muted">
            Files stay on your device.
            <template v-if="showDesktopHint">
              Paste or drop a folder.
            </template>
          </p>
          <div class="flex flex-wrap items-center justify-center gap-2">
            <UButton
              :label="multiple ? 'Choose files' : 'Choose a file'"
              icon="i-lucide-folder-open"
              @click.stop="open()"
            />
            <slot name="sample" />
          </div>
        </div>
      </template>
    </UFileUpload>

    <UAlert
      v-if="messages.length"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Some files were skipped"
      role="alert"
    >
      <template #description>
        <ul class="list-disc pl-5">
          <li v-for="m in messages" :key="m">
            {{ m }}
          </li>
        </ul>
      </template>
    </UAlert>
  </div>
</template>

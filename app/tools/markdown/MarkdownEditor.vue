<script setup lang="ts">
/**
 * Markdown editor: CodeMirror source + live, sanitised preview (markdown-it + DOMPurify + Shiki).
 * The draft autosaves to this browser. Open/save .md, export standalone HTML, print to PDF.
 */
import { useMediaQuery, watchDebounced } from '@vueuse/core'
import type { EditorView } from '@codemirror/view'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { ToolMeta } from '~/tools/meta'
import { createRenderer, docStats, docTitle, fenceLanguages } from './render'
import { ensureLanguages, highlight } from './highlight'
import { buildHtmlDocument } from './export'
import { commands, mountEditor, setDoc, type CommandName } from './editor'
import { sampleDocument } from './sample'
import './markdown.css'

const props = defineProps<{ meta: ToolMeta }>()

const DRAFT_KEY = 'toolify:markdown:draft'
const mdAccept = ['.md', '.markdown', '.mdown', '.mkd', '.txt', 'text/markdown', 'text/x-markdown', 'text/plain']

// ---------------------------------------------------------------------------
// document + draft
// ---------------------------------------------------------------------------

interface Draft { name: string; doc: string }
function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    const d = raw ? JSON.parse(raw) as Draft : null
    return d && typeof d.doc === 'string' ? d : null
  }
  catch {
    return null
  }
}
const initial = loadDraft()
const doc = shallowRef(initial?.doc ?? sampleDocument)
const fileName = ref(initial?.name ?? 'untitled.md')
const savedState = ref<'saved' | 'saving'>('saved')

watchDebounced([doc, fileName], () => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: fileName.value, doc: doc.value }))
  }
  catch { /* storage full or blocked: the editor still works */ }
  savedState.value = 'saved'
}, { debounce: 400 })
watch(doc, () => { savedState.value = 'saving' })

const stats = computed(() => docStats(doc.value))

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

const render = createRenderer({ highlight })
const html = ref(render(doc.value))
let renderSeq = 0
function refresh() {
  const seq = ++renderSeq
  const source = doc.value
  html.value = render(source)
  void ensureLanguages(fenceLanguages(source)).then((loadedNew) => {
    if (loadedNew && seq === renderSeq) html.value = render(source)
  }).catch(() => { /* highlighting is best-effort */ })
}
watchDebounced(doc, refresh, { debounce: 150, maxWait: 800 })
onMounted(refresh)

// ---------------------------------------------------------------------------
// editor
// ---------------------------------------------------------------------------

const editorHost = ref<HTMLElement | null>(null)
const previewEl = ref<HTMLElement | null>(null)
let view: EditorView | null = null
const syncScroll = ref(true)

onMounted(() => {
  if (!editorHost.value) return
  view = mountEditor(editorHost.value, {
    doc: doc.value,
    onChange: (d) => { doc.value = d },
    onScroll: (ratio) => {
      const el = previewEl.value
      if (!syncScroll.value || !el || mode.value !== 'split') return
      el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
    },
  })
})
onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

function run(name: CommandName) {
  if (!view) return
  if (mode.value === 'preview') mode.value = isLarge.value ? 'split' : 'edit'
  commands[name](view)
}
function heading(level: number) {
  if (view) commands.heading(view, level)
}

const toolbar: { name: CommandName; icon: string; label: string; kbd?: string }[][] = [
  [
    { name: 'bold', icon: 'i-lucide-bold', label: 'Bold', kbd: 'Ctrl B' },
    { name: 'italic', icon: 'i-lucide-italic', label: 'Italic', kbd: 'Ctrl I' },
    { name: 'strike', icon: 'i-lucide-strikethrough', label: 'Strikethrough' },
    { name: 'code', icon: 'i-lucide-code', label: 'Inline code', kbd: 'Ctrl E' },
    { name: 'link', icon: 'i-lucide-link', label: 'Link', kbd: 'Ctrl K' },
  ],
  [
    { name: 'bullet', icon: 'i-lucide-list', label: 'Bulleted list' },
    { name: 'numbered', icon: 'i-lucide-list-ordered', label: 'Numbered list' },
    { name: 'task', icon: 'i-lucide-list-todo', label: 'Task list' },
    { name: 'quote', icon: 'i-lucide-text-quote', label: 'Quote' },
  ],
  [
    { name: 'codeBlock', icon: 'i-lucide-square-code', label: 'Code block' },
    { name: 'table', icon: 'i-lucide-table', label: 'Table' },
    { name: 'rule', icon: 'i-lucide-minus', label: 'Horizontal rule' },
  ],
]
const headingIcons = ['i-lucide-heading-1', 'i-lucide-heading-2', 'i-lucide-heading-3', 'i-lucide-heading-4']
const headingItems = computed<DropdownMenuItem[][]>(() => [headingIcons.map((icon, i) => ({
  label: `Heading ${i + 1}`,
  icon,
  onSelect: () => heading(i + 1),
}))])

// ---------------------------------------------------------------------------
// view mode
// ---------------------------------------------------------------------------

type Mode = 'edit' | 'split' | 'preview'
const isLarge = useMediaQuery('(min-width: 1024px)')
const mode = ref<Mode>('split')
watch(isLarge, (large) => {
  if (!large && mode.value === 'split') mode.value = 'edit'
}, { immediate: true })
const modeItems = computed(() => [
  { label: 'Write', value: 'edit', icon: 'i-lucide-pencil' },
  ...(isLarge.value ? [{ label: 'Split', value: 'split', icon: 'i-lucide-columns-2' }] : []),
  { label: 'Preview', value: 'preview', icon: 'i-lucide-eye' },
])

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

const out = useFileOutput()
const toast = useToast()
const openEl = ref<HTMLInputElement | null>(null)

function baseName() {
  return fileName.value.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '') || 'untitled'
}
function title() {
  return docTitle(doc.value) ?? baseName()
}

async function openFile(file: File) {
  if (file.size > 20 * 1024 * 1024) {
    toast.add({ title: 'File too large', description: 'Markdown files up to 20 MB can be opened.', color: 'error' })
    return
  }
  const text = await file.text()
  fileName.value = /\.(md|markdown|mdown|mkd)$/i.test(file.name) ? file.name : `${file.name.replace(/\.[^.]+$/, '')}.md`
  doc.value = text
  if (view) setDoc(view, text)
  toast.add({ title: `Opened ${file.name}`, description: 'Undo (Ctrl Z) restores the previous text.', icon: 'i-lucide-file-text' })
}
function onPicked(e: Event) {
  const el = e.target as HTMLInputElement
  const f = el.files?.[0]
  el.value = ''
  if (f) void openFile(f)
}

const root = ref<HTMLElement | null>(null)
const { isOverDropZone } = useFileInput({
  accept: mdAccept,
  multiple: false,
  dropZone: root,
  paste: false,
  onAdded: (files) => { if (files[0]) void openFile(files[0]) },
})

function newDoc() {
  fileName.value = 'untitled.md'
  doc.value = ''
  if (view) setDoc(view, '')
  mode.value = isLarge.value ? 'split' : 'edit'
  view?.focus()
}

async function saveMarkdown() {
  const name = `${baseName()}.md`
  const res = await out.saveAs(new Blob([doc.value], { type: 'text/markdown' }), name)
  if (res !== 'cancelled') toast.add({ title: `Saved ${name}`, color: 'success', icon: 'i-lucide-circle-check' })
}
async function exportHtml() {
  refresh()
  const page = buildHtmlDocument(html.value, title())
  const name = `${baseName()}.html`
  const res = await out.saveAs(new Blob([page], { type: 'text/html' }), name)
  if (res !== 'cancelled') toast.add({ title: `Exported ${name}`, color: 'success', icon: 'i-lucide-circle-check' })
}
async function copyHtml() {
  try {
    await navigator.clipboard.writeText(html.value)
    toast.add({ title: 'HTML copied', icon: 'i-lucide-copy-check' })
  }
  catch {
    toast.add({ title: 'Could not copy', description: 'Clipboard access was blocked.', color: 'error' })
  }
}

// Print / PDF: a body-level copy of the preview is the only thing shown while printing.
const printing = ref(false)
function printDoc() {
  refresh()
  printing.value = true
  const prevTitle = document.title
  document.documentElement.classList.add('md-printing')
  document.title = title()
  const done = () => {
    document.documentElement.classList.remove('md-printing')
    document.title = prevTitle
    printing.value = false
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
  nextTick(() => {
    window.print()
    // Some browsers return from print() before afterprint (or never fire it).
    setTimeout(() => { if (printing.value) done() }, 1000)
  })
}

const fileMenu = computed<DropdownMenuItem[][]>(() => [
  [
    { label: 'New document', icon: 'i-lucide-file-plus', onSelect: newDoc },
    { label: 'Open…', icon: 'i-lucide-folder-open', onSelect: () => openEl.value?.click() },
  ],
  [
    { label: 'Save as Markdown', icon: 'i-lucide-download', onSelect: () => void saveMarkdown() },
    { label: 'Export HTML', icon: 'i-lucide-file-code', onSelect: () => void exportHtml() },
    { label: 'Print / Save as PDF', icon: 'i-lucide-printer', onSelect: printDoc },
    { label: 'Copy HTML', icon: 'i-lucide-copy', onSelect: () => void copyHtml() },
  ],
])

defineShortcuts({
  meta_s: { usingInput: true, handler: () => void saveMarkdown() },
  meta_o: { usingInput: true, handler: () => openEl.value?.click() },
  meta_p: { usingInput: true, handler: printDoc },
})

// Clicking an in-page anchor in the preview scrolls the preview, not the page.
function onPreviewClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  const href = a?.getAttribute('href')
  if (!href?.startsWith('#') || !previewEl.value) return
  e.preventDefault()
  const target = previewEl.value.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <div ref="root" class="relative flex h-[calc(100dvh-10rem)] min-h-[28rem] flex-col gap-3 p-3 sm:p-4 lg:h-[calc(100dvh-4rem)]" data-testid="markdown-editor">
    <input ref="openEl" type="file" :accept="mdAccept.join(',')" class="sr-only" tabindex="-1" aria-hidden="true" data-testid="open-input" @change="onPicked">

    <div
      v-if="isOverDropZone"
      class="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm"
      aria-hidden="true"
    >
      <p class="font-semibold text-primary">Drop a Markdown file to open it</p>
    </div>

    <!-- Top bar -->
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="sr-only">{{ props.meta.title }}</h1>
      <UInput
        v-model="fileName"
        aria-label="File name"
        icon="i-lucide-file-text"
        variant="ghost"
        class="min-w-0 flex-1 sm:max-w-xs"
        :ui="{ base: 'font-medium' }"
        data-testid="file-name"
      />
      <span class="hidden text-xs text-muted sm:inline" aria-live="polite">
        {{ savedState === 'saved' ? 'Draft saved on this device' : 'Saving…' }}
      </span>
      <div class="ms-auto flex items-center gap-2">
        <UTabs v-model="mode" :items="modeItems" :content="false" size="sm" variant="pill" aria-label="View" data-testid="view-mode" />
        <UDropdownMenu :items="fileMenu">
          <UButton icon="i-lucide-file-down" label="File" trailing-icon="i-lucide-chevron-down" color="neutral" variant="outline" data-testid="file-menu" />
        </UDropdownMenu>
      </div>
    </div>

    <!-- Formatting toolbar -->
    <div role="toolbar" aria-label="Formatting" class="flex items-center gap-1 overflow-x-auto rounded-lg border border-default bg-elevated/50 p-1">
      <UDropdownMenu :items="headingItems">
        <UButton icon="i-lucide-heading" trailing-icon="i-lucide-chevron-down" size="sm" color="neutral" variant="ghost" aria-label="Heading" />
      </UDropdownMenu>
      <template v-for="(group, gi) in toolbar" :key="gi">
        <USeparator orientation="vertical" class="mx-1 h-5" />
        <UTooltip v-for="b in group" :key="b.name" :text="b.label" :kbds="b.kbd ? b.kbd.split(' ').map(k => k === 'Ctrl' ? 'meta' : k) : undefined">
          <UButton :icon="b.icon" size="sm" color="neutral" variant="ghost" :aria-label="b.label" :data-testid="`fmt-${b.name}`" @click="run(b.name)" />
        </UTooltip>
      </template>
    </div>

    <!-- Panes -->
    <div class="grid min-h-0 flex-1 gap-3" :class="mode === 'split' ? 'grid-cols-2' : 'grid-cols-1'">
      <section
        v-show="mode !== 'preview'"
        class="min-h-0 overflow-hidden rounded-lg border border-default bg-default"
        aria-label="Markdown source"
      >
        <div ref="editorHost" class="h-full" data-testid="editor" />
      </section>
      <section
        v-show="mode !== 'edit'"
        ref="previewEl"
        class="min-h-0 overflow-y-auto rounded-lg border border-default bg-default"
        aria-label="Preview"
        tabindex="0"
        @click="onPreviewClick"
      >
        <!-- eslint-disable-next-line vue/no-v-html -- sanitised with DOMPurify in render.ts -->
        <article class="md-body mx-auto max-w-3xl px-5 py-6 sm:px-8" data-testid="preview" v-html="html" />
      </section>
    </div>

    <!-- Status bar -->
    <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
      <span data-testid="stats">{{ stats.words.toLocaleString() }} words · {{ stats.chars.toLocaleString() }} characters · {{ stats.minutes }} min read</span>
      <USwitch v-if="mode === 'split'" v-model="syncScroll" size="xs" label="Sync scrolling" />
    </div>

    <Teleport to="body">
      <!-- eslint-disable-next-line vue/no-v-html -- sanitised with DOMPurify in render.ts -->
      <div v-if="printing" class="md-print-only md-body" v-html="html" />
    </Teleport>
  </div>
</template>

<style>
.md-print-only { display: none; }
@media print {
  html.md-printing body > *:not(.md-print-only) { display: none !important; }
  html.md-printing .md-print-only { display: block; }
  html.md-printing, html.md-printing body { background: #fff !important; }
  html.md-printing.dark .md-print-only { --md-fg: #1f2328; --md-muted: #59636e; --md-border: #d1d9e0; --md-subtle: #f6f8fa; --md-link: #0969da; }
  html.md-printing.dark .md-print-only .shiki { background-color: var(--shiki-light-bg); }
  html.md-printing.dark .md-print-only .shiki span { color: var(--shiki-light); }
  @page { margin: 18mm 16mm; }
}
</style>

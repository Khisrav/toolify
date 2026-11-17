/**
 * Tool metadata. Pure data: safe to import from nuxt.config, the dashboard and tests.
 * Heavy code is never referenced here — see `registry.ts` for the lazy loaders.
 */
import type { CapabilityKey } from '../lib/capabilities'

export type ToolCategory = 'image' | 'document' | 'video' | 'utility'
export type ToolStatus = 'available' | 'soon'

export interface ToolMeta {
  slug: string
  title: string
  /** One line, shown on cards and as the meta description. */
  description: string
  category: ToolCategory
  /** Iconify name, e.g. `i-lucide-image`. */
  icon: string
  keywords: string[]
  status: ToolStatus
  /** MIME types / extensions accepted by the drop zone. */
  accepts?: string[]
  /** Hard requirements; if missing the tool shows an "unsupported" state. */
  requires?: CapabilityKey[]
  /** Engines downloaded on first use, shown before the download starts. */
  heavyAssets?: { label: string; approxMB: number }[]
}

export const categories: { id: ToolCategory; label: string; icon: string }[] = [
  { id: 'image', label: 'Images', icon: 'i-lucide-image' },
  { id: 'document', label: 'Documents', icon: 'i-lucide-file-text' },
  { id: 'video', label: 'Video', icon: 'i-lucide-film' },
  { id: 'utility', label: 'Utilities', icon: 'i-lucide-wrench' },
]

const imageAccepts = ['image/*', '.heic', '.heif', '.ico', '.bmp', '.avif']

export const tools: ToolMeta[] = [
  {
    slug: 'image-studio',
    title: 'Image Studio',
    description: 'Resize, convert and optimise many images in one pass. Drop a folder or a ZIP.',
    category: 'image',
    icon: 'i-lucide-layers',
    keywords: ['studio', 'bulk', 'batch', 'folder', 'zip', 'archive', 'convert', 'compress', 'optimize', 'resize', 'webp', 'jpg', 'png'],
    status: 'available',
    accepts: [...imageAccepts, '.zip', '.tar', '.tgz', '.tar.gz'],
  },
  {
    slug: 'markdown',
    title: 'Markdown Editor',
    description: 'Write Markdown with live preview, GFM and code highlighting.',
    category: 'document',
    icon: 'i-lucide-file-code',
    keywords: ['markdown', 'md', 'editor', 'preview', 'gfm'],
    status: 'soon',
  },
  {
    slug: 'docx-to-pdf',
    title: 'Word to PDF',
    description: 'Turn .docx documents into PDF.',
    category: 'document',
    icon: 'i-lucide-file-output',
    keywords: ['word', 'docx', 'pdf', 'convert'],
    status: 'soon',
  },
  {
    slug: 'pdf-to-docx',
    title: 'PDF to Word',
    description: 'Extract text and structure from PDF into .docx.',
    category: 'document',
    icon: 'i-lucide-file-input',
    keywords: ['pdf', 'word', 'docx', 'extract'],
    status: 'soon',
  },
  {
    slug: 'video-edit',
    title: 'Video Editor',
    description: 'Trim, cut, crop, rotate and merge clips.',
    category: 'video',
    icon: 'i-lucide-clapperboard',
    keywords: ['video', 'trim', 'cut', 'crop', 'merge', 'mp4'],
    status: 'soon',
  },
  {
    slug: 'video-optimize',
    title: 'Video Compressor',
    description: 'Re-encode video to a smaller size or another format.',
    category: 'video',
    icon: 'i-lucide-film',
    keywords: ['video', 'compress', 'encode', 'mp4', 'webm', 'bitrate'],
    status: 'soon',
  },
  {
    slug: 'keyboard-test',
    title: 'Keyboard Tester',
    description: 'Check every key, rollover and ghosting on your keyboard.',
    category: 'utility',
    icon: 'i-lucide-keyboard',
    keywords: ['keyboard', 'keys', 'test', 'ghosting', 'rollover', 'nkro'],
    status: 'soon',
  },
]

export const availableTools = tools.filter(t => t.status === 'available')

export function findTool(slug: string): ToolMeta | undefined {
  return tools.find(t => t.slug === slug)
}

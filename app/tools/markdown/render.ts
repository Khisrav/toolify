/**
 * Markdown → safe HTML. markdown-it (CommonMark + GFM tables/strikethrough, linkify, typographer)
 * with small in-repo plugins for task lists and heading anchors. Every render goes through DOMPurify.
 * Code highlighting is injected by the caller (see highlight.ts) so this module stays synchronous.
 */
import MarkdownIt from 'markdown-it'
import type { Options, PluginSimple } from 'markdown-it'
import DOMPurify from 'dompurify'

export type Highlighter = (code: string, lang: string) => string | null

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

/** `- [ ] todo` / `- [x] done` → disabled checkboxes (GFM task lists). */
const taskLists: PluginSimple = (md) => {
  md.core.ruler.after('inline', 'task-lists', (state) => {
    const tokens = state.tokens
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i]!
      if (inline.type !== 'inline' || tokens[i - 1]!.type !== 'paragraph_open' || tokens[i - 2]!.type !== 'list_item_open') continue
      const m = /^\[([ xX])\][ \t]/.exec(inline.content)
      const first = inline.children?.[0]
      if (!m || !first || first.type !== 'text') continue
      first.content = first.content.slice(m[0].length)
      inline.content = inline.content.slice(m[0].length)
      const box = new state.Token('html_inline', '', 0)
      box.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `
      inline.children!.unshift(box)
      tokens[i - 2]!.attrJoin('class', 'task-list-item')
      // Mark the enclosing list.
      for (let j = i - 3; j >= 0; j--) {
        const t = tokens[j]!
        if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === tokens[i - 2]!.level - 1) {
          if (!t.attrGet('class')?.includes('contains-task-list')) t.attrJoin('class', 'contains-task-list')
          break
        }
      }
    }
  })
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** Unique `id`s on headings so `[link](#section)` works. */
const headingAnchors: PluginSimple = (md) => {
  md.core.ruler.push('heading-anchors', (state) => {
    const used = new Map<string, number>()
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.type !== 'heading_open') continue
      const text = tokens[i + 1]?.children?.filter(t => t.type === 'text' || t.type === 'code_inline').map(t => t.content).join('') ?? ''
      const base = slugify(text) || 'section'
      const n = used.get(base) ?? 0
      used.set(base, n + 1)
      tokens[i]!.attrSet('id', n ? `${base}-${n}` : base)
    }
  })
}

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

let purifyHooked = false
function hookPurify() {
  if (purifyHooked) return
  purifyHooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? ''
      if (/^https?:\/\//i.test(href)) {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      }
    }
    // Only our own task checkboxes are kept; other inputs are inert.
    if (node.tagName === 'INPUT') {
      node.setAttribute('disabled', '')
    }
  })
}

export function createRenderer(options: { highlight?: Highlighter } = {}) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight: ((code: string, lang: string) => {
      const out = lang ? options.highlight?.(code, lang.toLowerCase()) : null
      if (out) return out
      return `<pre class="md-code"><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(code)}</code></pre>`
    }) as Options['highlight'],
  })
  md.use(taskLists).use(headingAnchors)
  hookPurify()

  return (source: string): string => {
    const raw = md.render(source)
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target'],
      FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
      FORBID_ATTR: ['autofocus'],
    })
  }
}

/** Fenced-code languages used in a document (` ```ts `, `~~~python`). */
export function fenceLanguages(source: string): string[] {
  const out = new Set<string>()
  for (const m of source.matchAll(/^[ \t]{0,3}(?:```|~~~)[ \t]*([\w+#-]+)/gm)) out.add(m[1]!.toLowerCase())
  return [...out]
}

export interface DocStats {
  words: number
  chars: number
  minutes: number
}

export function docStats(source: string): DocStats {
  const words = source.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0
  return { words, chars: source.length, minutes: Math.max(1, Math.round(words / 220)) }
}

/** First heading text, used for export titles. */
export function docTitle(source: string): string | null {
  const m = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(source)
  return m ? m[1]!.replace(/[*_`[\]]/g, '').trim() || null : null
}

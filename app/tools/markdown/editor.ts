/**
 * CodeMirror 6 for raw Markdown. The editor is mounted inside a shadow root: CodeMirror then
 * uses constructable stylesheets instead of injecting <style> tags, which our CSP forbids.
 * App colour tokens (CSS custom properties) still inherit through the shadow boundary.
 */
import { EditorSelection, EditorState, type ChangeSpec } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--ui-text)', backgroundColor: 'transparent', fontSize: '14px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': { padding: '16px 0', caretColor: 'var(--ui-primary)' },
  '.cm-line': { padding: '0 16px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--ui-bg-elevated) 70%, transparent)' },
  '.cm-cursor': { borderLeftColor: 'var(--ui-primary)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--ui-primary) 25%, transparent) !important',
  },
  '.cm-placeholder': { color: 'var(--ui-text-dimmed)' },
})

const highlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.25em', color: 'var(--ui-text-highlighted)' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.15em', color: 'var(--ui-text-highlighted)' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--ui-text-highlighted)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--ui-primary)' },
  { tag: t.monospace, color: 'var(--ui-secondary)' },
  { tag: t.quote, color: 'var(--ui-text-muted)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.labelName], color: 'var(--ui-text-dimmed)' },
  { tag: t.list, color: 'var(--ui-primary)' },
])

// ---------------------------------------------------------------------------
// formatting commands
// ---------------------------------------------------------------------------

/** Wrap each selection in `before`/`after`; toggles off if already wrapped. Empty selection inserts a placeholder. */
export function wrap(view: EditorView, before: string, after = before, filler = 'text'): boolean {
  const { state } = view
  view.dispatch(state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to)
    const outer = state.sliceDoc(range.from - before.length, range.to + after.length)
    if (!range.empty && outer.startsWith(before) && outer.endsWith(after)) {
      return {
        changes: [{ from: range.from - before.length, to: range.from }, { from: range.to, to: range.to + after.length }],
        range: EditorSelection.range(range.from - before.length, range.to - before.length),
      }
    }
    const inner = text || filler
    return {
      changes: { from: range.from, to: range.to, insert: before + inner + after },
      range: EditorSelection.range(range.from + before.length, range.from + before.length + inner.length),
    }
  }), { scrollIntoView: true, userEvent: 'input' })
  view.focus()
  return true
}

/** Toggle a line prefix (`# `, `- `, `> `, `1. `, `- [ ] `) on every selected line. */
export function prefixLines(view: EditorView, prefix: string | ((i: number) => string), strip?: RegExp): boolean {
  const { state } = view
  const changes: ChangeSpec[] = []
  const seen = new Set<number>()
  for (const r of state.selection.ranges) {
    let i = 0
    for (let pos = r.from; pos <= r.to;) {
      const line = state.doc.lineAt(pos)
      if (!seen.has(line.number)) {
        seen.add(line.number)
        const p = typeof prefix === 'function' ? prefix(i++) : prefix
        const existing = strip?.exec(line.text)?.[0] ?? ''
        if (existing === p) changes.push({ from: line.from, to: line.from + existing.length })
        else changes.push({ from: line.from, to: line.from + existing.length, insert: p })
      }
      pos = line.to + 1
    }
  }
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'input' })
  view.focus()
  return true
}

/** Insert a block (table, rule, code fence) on its own lines at the cursor. */
export function insertBlock(view: EditorView, block: string, select?: [number, number]): boolean {
  const { state } = view
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  const lead = line.text.trim() ? '\n\n' : line.number > 1 && state.doc.line(line.number - 1).text.trim() ? '\n' : ''
  const at = line.text.trim() ? line.to : line.from
  const insert = `${lead}${block}\n`
  const base = at + lead.length
  view.dispatch({
    changes: { from: at, insert },
    selection: select ? EditorSelection.range(base + select[0], base + select[1]) : EditorSelection.cursor(at + insert.length),
    scrollIntoView: true,
    userEvent: 'input',
  })
  view.focus()
  return true
}

const HEADING = /^#{1,6} /
const LIST = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+\. )/
const QUOTE = /^> /

export const commands = {
  bold: (v: EditorView) => wrap(v, '**', '**', 'bold text'),
  italic: (v: EditorView) => wrap(v, '_', '_', 'italic text'),
  strike: (v: EditorView) => wrap(v, '~~', '~~', 'struck text'),
  code: (v: EditorView) => wrap(v, '`', '`', 'code'),
  link: (v: EditorView) => {
    const { state } = v
    const r = state.selection.main
    const text = state.sliceDoc(r.from, r.to) || 'link text'
    const insert = `[${text}](https://)`
    v.dispatch({
      changes: { from: r.from, to: r.to, insert },
      selection: EditorSelection.range(r.from + text.length + 3, r.from + insert.length - 1),
      scrollIntoView: true,
      userEvent: 'input',
    })
    v.focus()
    return true
  },
  heading: (v: EditorView, level = 2) => prefixLines(v, `${'#'.repeat(level)} `, HEADING),
  bullet: (v: EditorView) => prefixLines(v, '- ', LIST),
  numbered: (v: EditorView) => prefixLines(v, i => `${i + 1}. `, LIST),
  task: (v: EditorView) => prefixLines(v, '- [ ] ', LIST),
  quote: (v: EditorView) => prefixLines(v, '> ', QUOTE),
  codeBlock: (v: EditorView) => insertBlock(v, '```ts\n\n```', [6, 6]),
  table: (v: EditorView) => insertBlock(v, '| Column | Column |\n| --- | --- |\n| Cell | Cell |', [2, 8]),
  rule: (v: EditorView) => insertBlock(v, '---'),
}

export type CommandName = keyof typeof commands

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

export interface MountOptions {
  doc: string
  onChange: (doc: string) => void
  onScroll?: (ratio: number) => void
  placeholder?: string
  label?: string
}

export function mountEditor(host: HTMLElement, opts: MountOptions): EditorView {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  shadow.replaceChildren()
  const container = document.createElement('div')
  container.style.height = '100%'
  shadow.appendChild(container)

  const view = new EditorView({
    root: shadow,
    parent: container,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlightStyle),
        EditorView.lineWrapping,
        theme,
        cmPlaceholder(opts.placeholder ?? 'Start writing Markdown…'),
        // Explicit tabindex: axe does not count contenteditable as keyboard access for the scroll region.
        EditorView.contentAttributes.of({ 'aria-label': opts.label ?? 'Markdown source', 'tabindex': '0', 'spellcheck': 'true', 'autocapitalize': 'sentences' }),
        keymap.of([
          { key: 'Mod-b', run: commands.bold },
          { key: 'Mod-i', run: commands.italic },
          { key: 'Mod-k', run: commands.link },
          { key: 'Mod-Shift-x', run: commands.strike },
          { key: 'Mod-e', run: commands.code },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString())
        }),
      ],
    }),
  })
  if (opts.onScroll) {
    view.scrollDOM.addEventListener('scroll', () => {
      const el = view.scrollDOM
      const max = el.scrollHeight - el.clientHeight
      opts.onScroll!(max > 0 ? el.scrollTop / max : 0)
    }, { passive: true })
  }
  return view
}

/** Replace the whole document (e.g. after opening a file), keeping undo history. */
export function setDoc(view: EditorView, doc: string) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: EditorSelection.cursor(0) })
}

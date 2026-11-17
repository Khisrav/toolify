// @vitest-environment jsdom
// jsdom: happy-dom drops the first element when DOMPurify parses HTML.
import { describe, expect, it } from 'vitest'
import { createRenderer, docStats, docTitle, fenceLanguages, slugify } from '~/tools/markdown/render'
import { canonicalLang } from '~/tools/markdown/highlight'

const render = createRenderer()

function dom(html: string) {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

describe('markdown rendering', () => {
  it('renders GFM tables, strikethrough and linkify', () => {
    const el = dom(render('| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~ https://example.com'))
    expect(el.querySelectorAll('td')).toHaveLength(2)
    expect(el.querySelector('s')?.textContent).toBe('gone')
    const a = el.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://example.com')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders task lists as disabled checkboxes', () => {
    const el = dom(render('- [ ] todo\n- [x] done\n- plain'))
    const boxes = el.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]!.checked).toBe(false)
    expect(boxes[1]!.checked).toBe(true)
    expect([...boxes].every(b => b.disabled)).toBe(true)
    expect(el.querySelector('ul')!.className).toContain('contains-task-list')
    expect(el.querySelectorAll('li.task-list-item')).toHaveLength(2)
    expect(el.textContent).toContain('todo')
    expect(el.textContent).not.toContain('[ ]')
  })

  it('adds unique heading anchors', () => {
    const el = dom(render('# Hello World\n## Hello World\n### Ünïcode `code`'))
    expect([...el.querySelectorAll('h1,h2,h3')].map(h => h.id)).toEqual(['hello-world', 'hello-world-1', 'unicode-code'])
  })

  it.each([
    ['<script>alert(1)</script>', 'script'],
    ['<img src=x onerror="alert(1)">', '[onerror]'],
    ['[click](javascript:alert(1))', 'a[href^="javascript"]'],
    ['<a href="javascript:alert(1)">x</a>', 'a[href^="javascript"]'],
    ['<iframe src="https://evil.test"></iframe>', 'iframe'],
    ['<svg><script>alert(1)</script></svg>', 'script'],
    ['<style>body{display:none}</style>', 'style'],
    ['<form action="https://evil.test"><input name=q></form>', 'form'],
    ['<div onclick="alert(1)">x</div>', '[onclick]'],
  ])('sanitises %s', (input, selector) => {
    const html = render(input)
    expect(dom(html).querySelector(selector)).toBeNull()
    // Dangerous text may survive as inert text; it must never be an attribute.
    expect(html).not.toMatch(/(href|src)\s*=\s*["']?javascript:|\son\w+\s*=/i)
  })

  it('keeps safe inline HTML', () => {
    const el = dom(render('<details><summary>More</summary>\n\nHidden <kbd>Ctrl</kbd></details>'))
    expect(el.querySelector('details summary')?.textContent).toBe('More')
    expect(el.querySelector('kbd')).not.toBeNull()
  })

  it('escapes code when no highlighter is loaded', () => {
    const el = dom(render('```ts\nconst a = "<b>"\n```'))
    expect(el.querySelector('pre code')?.textContent).toBe('const a = "<b>"\n')
    expect(el.querySelector('b')).toBeNull()
  })

  it('uses the injected highlighter', () => {
    const r = createRenderer({ highlight: (code, lang) => `<pre class="shiki"><code>${lang}:${code.trim()}</code></pre>` })
    expect(dom(r('```python\nx\n```')).querySelector('pre.shiki')?.textContent).toBe('python:x')
  })
})

describe('markdown helpers', () => {
  it('finds fence languages', () => {
    expect(fenceLanguages('```ts\na\n```\n~~~ Python\nb\n~~~\n```\nc\n```')).toEqual(['ts', 'python'])
  })
  it('maps language aliases', () => {
    expect(canonicalLang('ts')).toBe('typescript')
    expect(canonicalLang('SH')).toBe('bash')
    expect(canonicalLang('brainfuck')).toBeNull()
  })
  it('computes stats and titles', () => {
    expect(docStats('Hello, wonderful world! It’s fine.')).toMatchObject({ words: 5 })
    expect(docTitle('intro\n\n## The **Title** ##\n')).toBe('The Title')
    expect(docTitle('no heading')).toBeNull()
    expect(slugify('  Hello — World! ')).toBe('hello-world')
  })
})

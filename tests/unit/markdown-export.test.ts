import { describe, expect, it } from 'vitest'
import { buildHtmlDocument } from '~/tools/markdown/export'

describe('HTML export', () => {
  const page = buildHtmlDocument('<h1 id="x">Hi</h1>', 'My <doc>')
  it('is a self-contained document', () => {
    expect(page.startsWith('<!doctype html>')).toBe(true)
    expect(page).toContain('<title>My &lt;doc&gt;</title>')
    expect(page).toContain('.md-body')
    expect(page).not.toMatch(/<script|<link\b|https?:\/\/(?!www\.w3)/i)
  })
  it('carries dark colours for prefers-color-scheme', () => {
    expect(page).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*\.md-body \{/)
    expect(page).toContain('var(--shiki-dark)')
  })
})

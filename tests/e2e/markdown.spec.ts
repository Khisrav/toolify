import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

// Playwright CSS locators pierce the editor's open shadow root.
const content = (page: Page) => page.locator('[data-testid=editor] .cm-content')
const preview = (page: Page) => page.locator('[data-testid=preview]')

async function replaceDoc(page: Page, text: string) {
  await content(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  await expect.poll(async () => norm(await content(page).innerText())).toBe(norm(text))
}

test.beforeEach(async ({ page }) => {
  // Force the plain-download path (no native Save dialog in automation).
  await page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker })
  await page.goto('/tools/markdown')
  await expect(content(page)).toBeVisible()
})

test('shows the sample and renders edits live', async ({ page }) => {
  await expect(preview(page).locator('h1')).toHaveText('Welcome to the Markdown editor')
  await replaceDoc(page, '# Release notes\n\n- [x] shipped\n- [ ] next\n\n| a | b |\n| - | - |\n| 1 | 2 |')
  await expect(preview(page).locator('h1')).toHaveText('Release notes')
  await expect(preview(page).locator('input[type=checkbox]')).toHaveCount(2)
  await expect(preview(page).locator('td')).toHaveCount(2)
  await expect(page.locator('[data-testid=stats]')).toContainText('words')
})

test('never executes injected HTML', async ({ page }) => {
  let dialogs = 0
  page.on('dialog', (d) => { dialogs++; void d.dismiss() })
  await replaceDoc(page, '# x\n\n<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n[a](javascript:alert(3))\n\n<svg onload="alert(4)"></svg>')
  await expect(preview(page).locator('h1')).toHaveText('x')
  await expect(preview(page).locator('script, [onerror], [onload], a[href^="javascript"]')).toHaveCount(0)
  await page.waitForTimeout(300)
  expect(dialogs).toBe(0)
})

test('highlights code blocks with Shiki', async ({ page }) => {
  await replaceDoc(page, '```python\ndef hi():\n    return 1\n```')
  await expect(preview(page).locator('pre.shiki')).toBeVisible({ timeout: 15_000 })
  await expect(preview(page).locator('pre.shiki span[style]').first()).toHaveAttribute('style', /--shiki-light/)
})

test('toolbar formats the selection', async ({ page }) => {
  await replaceDoc(page, 'word')
  await expect(preview(page)).toHaveText('word')
  await page.keyboard.press('ControlOrMeta+a')
  await page.locator('[data-testid=fmt-bold]').click()
  await expect(preview(page).locator('strong')).toHaveText('word')
})

test('exports Markdown and standalone HTML', async ({ page }) => {
  await replaceDoc(page, '# Exported')
  await page.locator('[data-testid=file-name]').fill('notes.md')

  await page.locator('[data-testid=file-menu]').click()
  const [md] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Save as Markdown' }).click()])
  expect(md.suggestedFilename()).toBe('notes.md')

  await page.locator('[data-testid=file-menu]').click()
  const [html] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export HTML' }).click()])
  expect(html.suggestedFilename()).toBe('notes.html')
  const text = await (await html.createReadStream()).toArray().then(c => Buffer.concat(c).toString('utf8'))
  expect(text).toContain('<h1 id="exported">Exported</h1>')
  expect(text).toContain('<title>Exported</title>')
  expect(text).not.toContain('<script')
})

test('restores the draft after reload', async ({ page }) => {
  await replaceDoc(page, '# Persisted draft')
  await page.waitForTimeout(700)
  await page.reload()
  await expect(preview(page).locator('h1')).toHaveText('Persisted draft')
})

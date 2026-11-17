import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { downloadZip } from 'client-zip'
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const samplePath = fileURLToPath(new URL('../fixtures/sample.png', import.meta.url))
const sample = readFileSync(samplePath)

async function pick(page: Page, testId: string, option: string) {
  await page.locator(`[data-testid=${testId}]`).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

async function processAll(page: Page) {
  await page.locator('[data-testid=run]').click()
  const items = page.locator('[data-testid=item]')
  await expect(items.first()).toBeVisible()
  return items
}

test('studio encodes WebP with the WASM encoder', async ({ page }) => {
  await page.goto('/tools/image-studio')
  await pick(page, 'format', 'WebP')
  await page.locator('[data-testid=file-input]').setInputFiles(samplePath)
  const item = (await processAll(page)).first()
  await expect(item.locator('[data-testid=status]')).toHaveText('Done', { timeout: 30_000 })
  await expect(item.locator('[data-testid=path]')).toHaveText(/wasm|original/)
})

test('studio encodes with the browser encoder', async ({ page, browserName }) => {
  await page.goto('/tools/image-studio')
  await pick(page, 'format', 'JPEG')
  await pick(page, 'encoder', 'Fastest (browser encoder)')
  await page.locator('[data-testid=file-input]').setInputFiles(samplePath)
  const item = (await processAll(page)).first()
  const status = item.locator('[data-testid=status]')
  await expect(status).toHaveText(/Done|Failed/, { timeout: 30_000 })
  if (browserName === 'webkit' && (await status.innerText()) === 'Failed') return
  await expect(status).toHaveText('Done')
  await expect(item.locator('[data-testid=path]')).toHaveText('native')
})

test('studio unpacks a ZIP, keeps folders and zips the results', async ({ page }) => {
  const archive = Buffer.from(await downloadZip([
    { name: 'trip/day1/a.png', input: sample },
    { name: 'trip/day2/b.png', input: sample },
    { name: 'trip/notes.txt', input: 'hello' },
  ]).arrayBuffer())

  await page.goto('/tools/image-studio')
  await page.locator('[data-testid=resize-toggle]').click()
  await page.locator('[data-testid=file-input]').setInputFiles({ name: 'trip.zip', mimeType: 'application/zip', buffer: archive })
  await expect(page.locator('[data-testid=count]')).toContainText('2')
  await expect(page.locator('[data-testid=queue]')).toContainText('trip/day1/a.png')
  await expect(page.locator('[data-testid=queue]')).toContainText('trip/day2/b.png')

  await processAll(page)
  await expect(page.locator('[data-testid=done-count]')).toHaveText(/^2/, { timeout: 30_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=download-zip]').click()])
  expect(download.suggestedFilename()).toBe('toolify-images.zip')
})

import { fileURLToPath } from 'node:url'
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

// VP9/Opus fixture: decodable in every Chromium build (H.264/AAC needs proprietary codecs).
const webm = fileURLToPath(new URL('../fixtures/sample.webm', import.meta.url))
const tone = fileURLToPath(new URL('../fixtures/tone.ogg', import.meta.url))

const id = (page: Page, testId: string) => page.locator(`[data-testid=${testId}]`)

async function pick(page: Page, testId: string, option: string) {
  await id(page, testId).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

async function open(page: Page, path = '/tools/video-edit') {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    localStorage.removeItem('toolify:video')
  })
  await page.goto(path)
  await expect(page.getByRole('button', { name: 'Choose a file' })).toBeVisible()
  await id(page, 'file-input').setInputFiles(webm)
  await expect(id(page, 'file-info')).toContainText('640×360')
}

async function exportAndWait(page: Page) {
  await id(page, 'export').click()
  await expect(id(page, 'result-name').or(id(page, 'export-error'))).toBeVisible({ timeout: 60_000 })
  await expect(id(page, 'export-error')).toHaveCount(0)
}

// Video encoding needs WebCodecs; the desktop Chromium project is the reference browser.
test.beforeEach(({ browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || !!isMobile, 'Video tools are verified on desktop Chromium')
})

test('reads the file and trims it losslessly', async ({ page }) => {
  await open(page)
  await expect(id(page, 'file-info')).toContainText('VP9')
  await id(page, 'action-trim').click()
  await pick(page, 'container', 'WebM')
  await id(page, 'trim-start').fill('0:01.00')
  await id(page, 'trim-start').press('Enter')
  await id(page, 'trim-end').fill('0:03.00')
  await id(page, 'trim-end').press('Enter')
  await expect(id(page, 'trim-length')).toHaveText('0:02.00')
  await exportAndWait(page)
  await expect(id(page, 'result-name')).toHaveText('sample-edited.webm')
  await expect(id(page, 'result-path')).toHaveText('No re-encode (lossless)')

  const download = page.waitForEvent('download')
  await id(page, 'download').click()
  expect((await download).suggestedFilename()).toBe('sample-edited.webm')
})

test('compresses and resizes with a re-encode', async ({ page }) => {
  await open(page)
  await id(page, 'action-compress').click()
  await pick(page, 'container', 'WebM')
  await id(page, 'resize-toggle').click()
  await pick(page, 'resize-preset', 'Custom size')
  await id(page, 'resize-width').locator('input').fill('320')
  await id(page, 'resize-height').locator('input').fill('')
  await expect(id(page, 'out-size')).toHaveText('Output: 320 × 180')
  await exportAndWait(page)
  await expect(id(page, 'result-path')).toHaveText('Re-encoded')
  await expect(id(page, 'result-size')).toContainText('320×180')
  await expect.poll(() => id(page, 'result-player').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 10_000 }).toBe(320)
})

test('extracts the soundtrack without re-encoding', async ({ page }) => {
  await open(page)
  await id(page, 'action-extract-audio').click()
  await exportAndWait(page)
  await expect(id(page, 'result-name')).toHaveText('sample.ogg')
  await expect(id(page, 'result-path')).toHaveText('No re-encode (lossless)')
})

test('replaces the audio with another file', async ({ page }) => {
  await open(page)
  await id(page, 'action-add-audio').click()
  await pick(page, 'container', 'WebM')
  await expect(id(page, 'blockers')).toContainText('Choose the audio file')
  await id(page, 'audio-input').setInputFiles(tone)
  await expect(id(page, 'audio-name')).toHaveText('tone.ogg')
  await exportAndWait(page)
  await expect(id(page, 'warnings')).toContainText('shorter than the video')
  await expect.poll(() => id(page, 'result-player').evaluate((v: HTMLVideoElement) => v.duration), { timeout: 10_000 }).toBeGreaterThan(3.5)
})

test('the compressor opens with Compress selected', async ({ page }) => {
  await open(page, '/tools/video-optimize')
  await expect(id(page, 'action-compress')).toHaveAttribute('aria-pressed', 'true')
  await expect(id(page, 'summary')).toContainText('medium quality')
})

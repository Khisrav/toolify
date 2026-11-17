import { test, expect } from './fixtures'

test('works offline after SW install', async ({ page, context }) => {
  await page.goto('/')
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.reload()
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await context.setOffline(true)
  for (const p of ['/', '/tools/image-studio']) {
    await page.goto(p)
    expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(0)
  }
  await expect(page.locator('[data-testid=add-files]')).toBeVisible()
})

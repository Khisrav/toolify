import { test, expect } from './fixtures'

for (const path of ['/', '/tools/image-studio', '/settings', '/privacy']) {
  test(`smoke ${path}`, async ({ page }) => {
    const errors: string[] = []
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', e => errors.push(String(e)))
    const res = await page.goto(path)
    expect(res?.status()).toBe(200)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('main, [role=main], body').first()).not.toBeEmpty()
    expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })
}

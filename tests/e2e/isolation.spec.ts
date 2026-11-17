import { test, expect } from './fixtures'

test('cross-origin isolated with CSP', async ({ page }) => {
  const res = await page.goto('/')
  const h = res!.headers()
  expect(h['content-security-policy']).toContain("default-src 'self'")
  expect(h['cross-origin-opener-policy']).toBe('same-origin')
  expect(h['cross-origin-embedder-policy']).toBe('require-corp')
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true)
})

test('no CSP violations on load', async ({ page }) => {
  const violations: string[] = []
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', e => ((window as unknown as { __csp?: string[] }).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  for (const p of ['/', '/tools/image-studio', '/tools/markdown']) {
    await page.goto(p)
    await page.waitForLoadState('networkidle')
    violations.push(...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])))
  }
  expect(violations).toEqual([])
})

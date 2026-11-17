import { test as base, expect } from '@playwright/test'

const ORIGIN = `http://localhost:${process.env.PW_PORT || 4173}`

/** Extends `test` with a network guard: any request to a non-local origin fails the test. */
export const test = base.extend<{ externalRequests: string[] }>({
  externalRequests: [async ({ context }, use) => {
    const external: string[] = []
    const check = (url: string) => {
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return
      if (new URL(url).origin !== ORIGIN) external.push(url)
    }
    context.on('request', r => check(r.url()))
    await use(external)
    expect(external, 'external network requests').toEqual([])
  }, { auto: true }],
})
export { expect }

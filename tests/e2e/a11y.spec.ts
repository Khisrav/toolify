import AxeBuilder from '@axe-core/playwright'
import { test, expect } from './fixtures'

for (const path of ['/', '/tools/image-studio']) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`a11y ${path} (${colorScheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      const bad = violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
      expect(bad.map(v => `${v.id} [${v.impact}]: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`)).toEqual([])
    })
  }
}

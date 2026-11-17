import { defineConfig, devices } from '@playwright/test'

// Optional overrides for machines whose installed browser build differs from this Playwright's pin.
const chromiumPath = process.env.PW_CHROMIUM_PATH
const firefoxPath = process.env.PW_FIREFOX_PATH

// Prerequisite: `npm run generate` (also runs postgenerate -> _headers) so .output/public exists.
export default defineConfig({
  testDir: 'tests/e2e',
  reporter: 'list',
  fullyParallel: true,
  retries: 0,
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure', serviceWorkers: 'allow' },
  webServer: {
    command: 'node scripts/serve.mjs 4173',
    url: 'http://localhost:4173/',
    reuseExistingServer: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: chromiumPath } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: { executablePath: firefoxPath } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'Pixel 7', use: { ...devices['Pixel 7'], launchOptions: { executablePath: chromiumPath } } },
    { name: 'iPhone 15', use: { ...devices['iPhone 15'] } },
  ],
})

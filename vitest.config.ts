import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Plain Vitest for pure logic (queue, helpers, encoders' pure parts).
// Nuxt-aware component tests can opt in per file with `// @vitest-environment nuxt`.
export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'happy-dom',
  },
})

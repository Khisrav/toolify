// https://nuxt.com/docs/api/configuration/nuxt-config
import { toolRoutes } from './app/tools/routes'

// Cross-origin isolation (SharedArrayBuffer → threaded WASM). Mirrors public/_headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

// Icons Nuxt UI references dynamically through app.config (not discoverable by the scanner).
const nuxtUiDefaultIcons = [
  'arrow-down', 'arrow-left', 'arrow-right', 'arrow-up', 'arrow-up-right', 'check', 'chevron-down',
  'chevron-left', 'chevron-right', 'chevrons-left', 'chevrons-right', 'chevron-up', 'circle-alert',
  'circle-check', 'circle-x', 'copy', 'copy-check', 'ellipsis', 'eye', 'eye-off', 'file', 'folder',
  'folder-open', 'grip-vertical', 'hash', 'info', 'lightbulb', 'loader-circle', 'menu', 'minus',
  'monitor', 'moon', 'panel-left-close', 'panel-left-open', 'plus', 'rotate-ccw', 'search', 'square',
  'star', 'sun', 'terminal', 'triangle-alert', 'upload', 'x',
].map(n => `lucide:${n}`)

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },

  modules: ['@nuxt/ui', '@pinia/nuxt', '@vueuse/nuxt', '@vite-pwa/nuxt', '@nuxt/eslint'],

  css: ['~/assets/css/main.css'],

  // Static output: `nuxt generate` prerenders every route; tool workspaces are client-only.
  ssr: true,
  nitro: {
    prerender: {
      routes: ['/', ...toolRoutes, '/settings', '/privacy', '/about', '/licenses'],
      crawlLinks: false,
    },
  },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Toolify',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'description', content: 'Private file tools that run entirely on your device. Nothing is uploaded.' },
        { name: 'theme-color', content: '#4f46e5' },
        { name: 'referrer', content: 'no-referrer' },
      ],
      link: [
        { rel: 'icon', href: '/favicon.ico' },
        { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' },
        { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
      ],
    },
  },

  // --- Nuxt UI: no runtime network, no build-time font downloads ---
  ui: {
    fonts: false,
    theme: { colors: ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral'] },
  },
  icon: {
    // SVG mode: the default CSS mode injects one inline <style> per icon at runtime, which the CSP blocks.
    mode: 'svg',
    provider: 'none',
    fallbackToApi: false,
    serverBundle: false,
    // Scan .ts too: tool/category icons are declared in app/tools/meta.ts.
    clientBundle: { scan: { globInclude: ['app/**/*.{vue,ts}'] }, icons: nuxtUiDefaultIcons, sizeLimitKb: 256 },
  },
  colorMode: { preference: 'system', fallback: 'light', classSuffix: '', storageKey: 'toolify-color-mode' },

  // --- PWA: precache the shell, lazily cache WASM on first use ---
  pwa: {
    registerType: 'prompt',
    strategies: 'generateSW',
    manifest: {
      name: 'Toolify — private file tools',
      short_name: 'Toolify',
      description: 'File tools that run entirely on your device.',
      theme_color: '#4f46e5',
      background_color: '#ffffff',
      display: 'standalone',
      start_url: '/',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      navigateFallback: '/',
      globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
      globIgnores: ['wasm/**', '**/*.wasm'],
      maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      runtimeCaching: [
        {
          // Self-hosted WASM lives under versioned paths, so cache-first never goes stale.
          urlPattern: ({ url, sameOrigin }) => sameOrigin && (url.pathname.startsWith('/wasm/') || url.pathname.endsWith('.wasm')),
          handler: 'CacheFirst',
          options: { cacheName: 'toolify-wasm', expiration: { maxEntries: 60 }, cacheableResponse: { statuses: [200] } },
        },
      ],
    },
    client: { installPrompt: true },
    devOptions: { enabled: false },
  },

  vite: {
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@jsquash/jpeg', '@jsquash/webp'] },
  },

  typescript: { strict: true, typeCheck: false },
})

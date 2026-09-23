import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Ship a new service worker as soon as one is available. The app is a
      // thin shell over a live API, so there is no value in asking the user to
      // approve an update they cannot evaluate.
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'ACME Facility Incident Management',
        short_name: 'ACME Facilities',
        description:
          'Report and track facility and workplace technology incidents at ACME Inc.',
        theme_color: '#1a4f8a',
        background_color: '#f4f6f9',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the shell only.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],

        // Serve index.html for client-side routes when offline, but never for
        // /api: without this denylist a failed API call would be answered with
        // the HTML shell, and the client would try to parse it as JSON.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],

        // The API is deliberately absent from runtimeCaching. Incident data is
        // live and per-user; a cached response would show one person another's
        // view, or stale state presented as current. Requests go to the network
        // or fail honestly, and the UI reports that.
        runtimeCaching: [],

        cleanupOutdatedCaches: true,
      },
      devOptions: {
        // Off in development: a service worker caching a dev bundle is a
        // reliable way to spend an afternoon debugging a stale page.
        enabled: false,
      },
    }),
  ],
  server: {
    port: 3000
  },
  test: {
    // Components render into jsdom; the slice and service tests need no DOM but
    // share the environment so there is a single config.
    environment: 'jsdom',
    globals: true,
    // The default glob would also match e2e/*.spec.js, which are Playwright
    // specs and cannot run under Vitest.
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    setupFiles: './src/test/setup.js',
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx', 'src/test/**']
    }
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * Split the large, rarely-changing libraries out of the app bundle so a
         * code change does not invalidate the whole download in CloudFront.
         *
         * Assignment is by module path rather than by entry point: naming entry
         * packages makes Rollup hoist their shared dependencies and produces
         * circular chunks, whereas every module here lands in exactly one group.
         *
         * @param {string} id Absolute module id being bundled.
         * @returns {string|undefined} The chunk name, or undefined for app code.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@mui') || id.includes('@emotion')) return 'mui'
          if (id.includes('redux')) return 'redux'
          return 'vendor'
        }
      }
    }
  }
})

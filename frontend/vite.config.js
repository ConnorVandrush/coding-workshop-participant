import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000
  },
  test: {
    // Components render into jsdom; the slice and service tests need no DOM but
    // share the environment so there is a single config.
    environment: 'jsdom',
    globals: true,
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

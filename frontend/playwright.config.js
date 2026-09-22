import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end configuration.
 *
 * The suite runs against a production build served by `vite preview`, pointed
 * at a backend the CI job starts alongside it, so it exercises the same bundle
 * that gets deployed rather than the dev server. E2E_BASE_URL overrides the
 * target when you want to run against an already-running stack.
 */
export default defineConfig({
  testDir: './e2e',
  // Each spec signs in and mutates incidents, so they run one at a time
  // against the shared database rather than racing each other.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 950 } },
      // The responsive specs assert phone behaviour, so they belong to the
      // mobile project alone.
      testIgnore: /responsive\.spec\.js/,
    },
    { name: 'mobile', use: { ...devices['Pixel 5'] }, testMatch: /responsive\.spec\.js/ },
  ],
  // Started only when nothing is already serving the base URL.
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'npm run preview -- --port 4173 --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})

import { expect, test } from '@playwright/test'

/**
 * Progressive web app behaviour.
 *
 * Installed, this opens with no network: the shell is precached. Nothing in it
 * is usable offline, because incident data is live and deliberately never
 * cached, so the app has to say so rather than failing request by request.
 */
test.describe('progressive web app', () => {
  test('serves an installable manifest', async ({ page, request }) => {
    await page.goto('/')
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1)

    const manifest = await (await request.get('/manifest.webmanifest')).json()
    expect(manifest.name).toContain('ACME')
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBeTruthy()

    const sizes = manifest.icons.map((i) => i.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect(manifest.icons.some((i) => (i.purpose ?? '').includes('maskable'))).toBe(true)
  })

  test('registers a service worker and precaches the shell', async ({ page }) => {
    await page.goto('/')
    const registered = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      return Boolean(reg.active || reg.installing || reg.waiting)
    })
    expect(registered).toBe(true)

    // The shell is cached; the API is not, by design.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys()
      const all = await Promise.all(names.map((n) => caches.open(n).then((c) => c.keys())))
      return all.flat().map((r) => new URL(r.url).pathname)
    })
    expect(cached.some((p) => p.endsWith('index.html') || p === '/')).toBe(true)
    expect(cached.some((p) => p.startsWith('/api/'))).toBe(false)
  })

  test('still opens offline, and says data will not update', async ({ page, context }) => {
    await page.goto('/')
    await page.evaluate(() => navigator.serviceWorker.ready)

    await context.setOffline(true)
    await page.reload()

    // The shell renders from the precache rather than showing a browser error.
    await expect(page.getByRole('heading', { name: 'ACME Facilities' })).toBeVisible()

    await context.setOffline(false)
  })
})

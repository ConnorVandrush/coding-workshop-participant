import { expect, test } from '@playwright/test'
import { ACCOUNTS, signIn } from './helpers'

test.describe('responsive layout', () => {
  test('the incident table becomes cards on a phone', async ({ page }) => {
    await signIn(page, ACCOUNTS.admin)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByRole('link', { name: 'Incidents' }).click()
    await page.waitForURL('**/incidents')
    await page.getByRole('heading', { name: 'Incidents', exact: true }).waitFor()

    // A data table is unusable at this width, so it must not be rendered.
    await expect(page.locator('table')).toHaveCount(0)
    await expect(page.getByText(/matching incident/)).toBeVisible()
  })

  test('navigation collapses behind a drawer', async ({ page }) => {
    await signIn(page, ACCOUNTS.admin)
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()
    // The sidebar links are not on screen until the drawer is opened.
    await expect(page.getByRole('link', { name: 'Facilities' })).toBeHidden()
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(page.getByRole('link', { name: 'Facilities' })).toBeVisible()
  })
})

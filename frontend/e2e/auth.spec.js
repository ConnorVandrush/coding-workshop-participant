import { expect, test } from '@playwright/test'
import { ACCOUNTS, PASSWORD, signIn, signOut } from './helpers'

test.describe('authentication', () => {
  test('an anonymous visitor is sent to the login page', async ({ page }) => {
    await page.goto('/incidents')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'ACME Facilities' })).toBeVisible()
  })

  test('wrong credentials are reported without signing the user in', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('Work email').fill(ACCOUNTS.admin)
    await page.getByLabel('Password').fill('definitely-not-the-password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('Email or password is incorrect')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('registration rejects an address outside the corporate domain', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: 'Register' }).click()
    await page.getByLabel('Full name').fill('Outside Person')
    await page.getByLabel('Work email').fill('someone@gmail.com')
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByText(/acme\.inc domain/)).toBeVisible()
  })

  test('a session survives a page reload and ends on sign out', async ({ page }) => {
    await signIn(page, ACCOUNTS.admin)
    await page.reload()
    // The token is restored from storage and revalidated, not discarded.
    await expect(page.getByText('Facility Admin overview')).toBeVisible()

    await signOut(page)
    await page.goto('/incidents')
    await expect(page).toHaveURL(/\/login/)
  })
})

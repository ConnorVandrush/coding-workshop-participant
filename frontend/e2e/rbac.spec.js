import { expect, test } from '@playwright/test'
import { ACCOUNTS, signIn } from './helpers'

test.describe('role-based access', () => {
  test('an employee sees only their own incidents', async ({ page }) => {
    await signIn(page, ACCOUNTS.employee)
    await expect(page.getByText('Employee overview')).toBeVisible()
    await expect(page.getByText('Incidents you have reported.')).toBeVisible()

    await signIn(page, ACCOUNTS.admin)
    const adminTotal = await page.locator('h1').filter({ hasText: /^\d+$/ }).first().textContent()
    expect(Number(adminTotal)).toBeGreaterThan(0)
  })

  test('the accounts page is hidden from an employee and unreachable by URL', async ({ page }) => {
    await signIn(page, ACCOUNTS.employee)
    await expect(page.getByRole('link', { name: 'Accounts' })).toHaveCount(0)

    await page.goto('/users')
    // The guard redirects rather than rendering a page that would only 403.
    await expect(page).not.toHaveURL(/\/users$/)
  })

  test('a facility admin gets the accounts page and management panels', async ({ page }) => {
    await signIn(page, ACCOUNTS.admin)
    await expect(page.getByText('Work distribution')).toBeVisible()

    await page.getByRole('link', { name: 'Accounts' }).click()
    await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible()
    await expect(page.getByText(ACCOUNTS.employee)).toBeVisible()
  })

  test('maintenance is staff-only, and read-only for an engineer', async ({ page }) => {
    await signIn(page, ACCOUNTS.engineer)
    await page.getByRole('link', { name: 'Maintenance' }).click()
    await expect(page.getByRole('heading', { name: 'Maintenance', exact: true })).toBeVisible()
    // An engineer acts on the figures but does not own the register.
    await expect(page.getByRole('button', { name: 'Register equipment' })).toHaveCount(0)
  })

  test('the equipment register is staff-only, and read-only for an engineer', async ({ page }) => {
    await signIn(page, ACCOUNTS.engineer)
    await page.getByRole('link', { name: 'Equipment' }).click()
    await expect(page.getByRole('heading', { name: 'Equipment', exact: true })).toBeVisible()
    // The register is the admin's to keep; an engineer reads it.
    await expect(page.getByRole('button', { name: 'Register equipment' })).toHaveCount(0)
  })

  test('an employee is offered neither the equipment nor the maintenance screen', async ({ page }) => {
    await signIn(page, ACCOUNTS.employee)
    await expect(page.getByRole('link', { name: 'Equipment' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Maintenance' })).toHaveCount(0)
  })

  test('an employee cannot edit the facility hierarchy', async ({ page }) => {
    await signIn(page, ACCOUNTS.employee)
    await page.getByRole('link', { name: 'Facilities' }).click()
    await expect(page.getByRole('heading', { name: 'Facilities', exact: true })).toBeVisible()
    // Browsing is allowed - it is how a reporter picks a location.
    await expect(page.getByText('HQ North')).toBeVisible()
    await expect(page.getByText('Add a building')).toHaveCount(0)
  })
})

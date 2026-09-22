/**
 * Shared helpers for the end-to-end suite.
 *
 * Every seeded account uses the same password, which `bin/seed-database.py`
 * prints when it runs.
 */

export const PASSWORD = process.env.E2E_PASSWORD || 'Workshop#2026'

export const ACCOUNTS = {
  admin: 'admin@acme.inc',
  engineer: 'sam.okafor@acme.inc',
  employee: 'dana.ruiz@acme.inc',
}

/**
 * Sign in through the real login form.
 *
 * @param {import('@playwright/test').Page} page The page under test.
 * @param {string} email The account to sign in as.
 */
export async function signIn(page, email) {
  await page.goto('/')

  const emailField = page.getByLabel('Work email')
  const signOutButton = page.getByRole('button', { name: 'Sign out' })

  // Wait until the app has settled into either state before deciding. Checking
  // for the sign-out button too early returns zero while React is still
  // mounting, which skips the sign-out and then waits for a form that the
  // signed-in app never renders.
  await emailField.or(signOutButton).first().waitFor()

  // Several specs switch persona inside one test, and a browser context keeps
  // its token in localStorage, so sign the previous user out first.
  if (await signOutButton.isVisible()) {
    await signOutButton.click()
    await emailField.waitFor()
  }

  await emailField.fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForSelector('text=overview', { timeout: 30_000 })
}

/**
 * Sign out through the app bar.
 *
 * @param {import('@playwright/test').Page} page The page under test.
 */
export async function signOut(page) {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.waitForSelector('text=Sign in')
}

/**
 * Open the incident list and wait for rows.
 *
 * Anchors on the heading first: the dashboard's engineer table is still
 * mounted immediately after the URL changes and would be matched instead.
 *
 * @param {import('@playwright/test').Page} page The page under test.
 */
export async function openIncidents(page) {
  await page.getByRole('link', { name: 'Incidents' }).click()
  await page.waitForURL('**/incidents')
  await page.getByRole('heading', { name: 'Incidents', exact: true }).waitFor()
  await page.locator('table tbody tr').first().waitFor()
}

/**
 * Report an incident and return its title.
 *
 * @param {import('@playwright/test').Page} page The page under test.
 * @param {string} title Unique incident title.
 * @returns {Promise<string>} The title that was used.
 */
export async function reportIncident(page, title) {
  await page.getByRole('button', { name: 'Report incident' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill(title)
  await dialog.getByLabel('What is wrong?').fill('Raised by the end-to-end suite.')
  await dialog.getByRole('button', { name: 'Report', exact: true }).click()
  await page.getByText(/Incident #\d+ reported/).waitFor()
  return title
}

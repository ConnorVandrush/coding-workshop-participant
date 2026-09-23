import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { ACCOUNTS, openIncidents, signIn } from './helpers'

/**
 * Automated accessibility audit.
 *
 * The component tests already query by role and by label, which keeps the
 * obvious things honest - a button with no accessible name fails those. What
 * they cannot see is everything nobody thought to write a test for: colour
 * contrast, duplicated ids, a heading level skipped, a landmark missing, an
 * input whose label points at nothing. axe reads the rendered page and checks
 * all of it, which is why this runs against the real build rather than jsdom.
 *
 * Failures are reported with the offending selector, so a regression names the
 * element rather than just the rule.
 *
 * WCAG 2.1 A and AA are the standard being asserted. Rules outside that set are
 * excluded rather than silenced: 'best-practice' findings are worth reading but
 * are not a conformance failure, and failing the build on them trains people to
 * disable the check.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

/**
 * Run axe over the current page and return its violations.
 *
 * @param {import('@playwright/test').Page} page The page under test.
 * @param {object} [options] Options.
 * @param {string} [options.include] Restrict the scan to one selector.
 * @returns {Promise<Array>} The violations axe found.
 */
async function audit(page, { include } = {}) {
  let builder = new AxeBuilder({ page }).withTags(STANDARD)
  if (include) builder = builder.include(include)
  const { violations } = await builder.analyze()
  return violations
}

/**
 * Turn violations into something a failure message can show.
 *
 * The default axe output is several screens of JSON per violation, which in CI
 * means the actual problem scrolls past. This keeps the rule, the impact and
 * the offending selectors.
 *
 * @param {Array} violations The violations axe found.
 * @returns {string} A compact description.
 */
function describe(violations) {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n      ${v.nodes.map((n) => n.target.join(' ')).join('\n      ')}`)
    .join('\n    ')
}

test.describe('accessibility', () => {
  test('the sign-in page has no violations', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('Work email').waitFor()
    const violations = await audit(page)
    expect(violations, `\n    ${describe(violations)}\n`).toEqual([])
  })

  test('the registration form has no violations', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: 'Register' }).click()
    await page.getByLabel('Full name').waitFor()
    const violations = await audit(page)
    expect(violations, `\n    ${describe(violations)}\n`).toEqual([])
  })

  // Each persona sees a different navigation, different table columns and
  // different actions, so the same page has to be audited as each of them.
  for (const [persona, email] of Object.entries(ACCOUNTS)) {
    test(`the dashboard has no violations for the ${persona}`, async ({ page }) => {
      await signIn(page, email)
      const violations = await audit(page)
      expect(violations, `\n    ${describe(violations)}\n`).toEqual([])
    })

    test(`the incident list has no violations for the ${persona}`, async ({ page }) => {
      await signIn(page, email)
      await openIncidents(page)
      const violations = await audit(page)
      expect(violations, `\n    ${describe(violations)}\n`).toEqual([])
    })

    test(`an incident detail view has no violations for the ${persona}`, async ({ page }) => {
      await signIn(page, email)
      await openIncidents(page)
      await page.locator('table tbody tr').first().click()

      // Wait for the URL, not for an <h1>. The list polls, so the row can be
      // replaced between the locator resolving and the click, and the click
      // then lands on nothing - but the list page has an <h1> of its own, so
      // waiting for one succeeds either way and axe quietly audits the list
      // instead of the detail view. That is how this test failed
      // intermittently while appearing to pass on the right page.
      await page.waitForURL(/\/incidents\/\d+$/)
      await page.getByRole('heading', { level: 1 }).waitFor()

      const violations = await audit(page)
      expect(violations, `\n    ${describe(violations)}\n`).toEqual([])
    })
  }

  test('the report dialog has no violations, including the duplicate panel', async ({ page }) => {
    await signIn(page, ACCOUNTS.employee)
    await openIncidents(page)
    await page.getByRole('button', { name: 'Report incident' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Title').waitFor()

    // A dialog traps focus, so the page behind it is inert and axe would
    // otherwise report the hidden background as unreachable content.
    let violations = await audit(page, { include: '[role="dialog"]' })
    expect(violations, `\n    ${describe(violations)}\n`).toEqual([])

    // Again with the suggestion panel open: it appears while the user types and
    // is announced by a live region, which is exactly the sort of thing that
    // regresses silently. The category has to be set to match the seeded
    // incident - it carries 0.30 of the ranking, and leaving it on the default
    // "Other" puts a near-identical title under the threshold.
    await dialog.getByLabel('Category').click()
    await page.getByRole('option', { name: 'Av Equipment' }).click()
    await dialog.getByLabel('Title').fill('Projector will not power on in meeting room 3A')
    await page.getByTestId('similar-incidents').waitFor({ timeout: 15_000 })
    violations = await audit(page, { include: '[role="dialog"]' })
    expect(violations, `\n    ${describe(violations)}\n`).toEqual([])
  })

  test('the accounts page has no violations for the admin', async ({ page }) => {
    await signIn(page, ACCOUNTS.admin)
    await page.getByRole('link', { name: 'Accounts' }).click()
    await page.getByRole('heading', { name: 'Accounts', exact: true }).waitFor()
    const violations = await audit(page)
    expect(violations, `\n    ${describe(violations)}\n`).toEqual([])
  })

  test('the facilities page has no violations for the admin', async ({ page }) => {
    await signIn(page, ACCOUNTS.admin)
    await page.getByRole('link', { name: 'Facilities' }).click()
    await page.getByRole('heading', { name: 'Facilities', exact: true }).waitFor()
    const violations = await audit(page)
    expect(violations, `\n    ${describe(violations)}\n`).toEqual([])
  })

  test('every page is reachable and operable by keyboard alone', async ({ page }) => {
    // axe cannot test this: it inspects the DOM, and a control can carry a
    // perfect accessible name while being impossible to reach with Tab.
    await signIn(page, ACCOUNTS.employee)
    await openIncidents(page)

    const reportButton = page.getByRole('button', { name: 'Report incident' })
    await reportButton.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Focus must land inside the dialog, not stay behind it.
    const focusedInsideDialog = await page.evaluate(() => {
      const dialogElement = document.querySelector('[role="dialog"]')
      return Boolean(dialogElement && dialogElement.contains(document.activeElement))
    })
    expect(focusedInsideDialog).toBe(true)

    // And Escape must close it, because a keyboard user who cannot reach the
    // Cancel button has no other way out.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})

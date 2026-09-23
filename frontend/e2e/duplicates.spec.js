import { expect, test } from '@playwright/test'
import { ACCOUNTS, openIncidents, reportIncident, signIn } from './helpers'

/**
 * Duplicate detection, end to end against the real ranking.
 *
 * The unit tests stub the API, so they prove the panel renders whatever it is
 * given. What they cannot prove is that the SQL actually ranks a differently
 * worded report as the same fault. These specs type a genuinely different
 * sentence and let PostgreSQL decide.
 *
 * Each test seeds the incident it matches against, using an invented noun for
 * the broken thing so that repeated runs against a shared database cannot match
 * each other's leftovers. The noun carries no fixed prefix on purpose: an
 * earlier version began every one with the same word, and since trigram
 * similarity does not care where the overlap falls, every run matched every
 * previous run's incidents.
 *
 * @returns {string} A nonsense noun unlikely to appear in any other incident.
 */
const uniqueNoun = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)

test.describe('duplicate detection', () => {
  test('a reworded report is recognised as one already filed', async ({ page }) => {
    const noun = uniqueNoun()
    await signIn(page, ACCOUNTS.employee)
    await openIncidents(page)
    await reportIncident(page, `The ${noun} will not power on in meeting room 3A`)

    await page.getByRole('button', { name: 'Report incident' }).click()
    const dialog = page.getByRole('dialog')
    // Deliberately not the same sentence: reordered, a different verb, and the
    // noun misspelled by a character. Full-text search cannot join these two -
    // only the trigram ranking can. Measured at ~0.60 against a threshold of
    // 0.55, and stable to ±0.01 across random nouns.
    await dialog.getByLabel('Title').fill(`Meeting room 3A ${noun.slice(0, -1)} dead, will not switch on`)

    const panel = page.getByTestId('similar-incidents')
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByText(new RegExp(noun, 'i')).first()).toBeVisible()
    await expect(panel.getByText(/Matched because/).first()).toBeVisible()
  })

  test('a suggested duplicate never blocks the report', async ({ page }) => {
    const noun = uniqueNoun()
    await signIn(page, ACCOUNTS.employee)
    await openIncidents(page)
    await reportIncident(page, `The ${noun} will not power on in meeting room 3A`)

    await page.getByRole('button', { name: 'Report incident' }).click()
    const dialog = page.getByRole('dialog')
    // Worded closely enough that the panel is certain to fire, because what is
    // under test is that the reporter can proceed regardless.
    await dialog.getByLabel('Title').fill(`The ${noun} will not power on in meeting room 3A again`)
    await dialog.getByLabel('What is wrong?').fill('Reporting it anyway: mine is a separate unit.')
    await expect(page.getByTestId('similar-incidents')).toBeVisible({ timeout: 15_000 })

    // The panel is advice, never a gate.
    const submit = dialog.getByRole('button', { name: 'Report', exact: true })
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(page.getByText(/Incident #\d+ reported/)).toBeVisible()
  })

  test('a different fault on the same equipment is not flagged', async ({ page }) => {
    // The counterweight to the first spec. Sharing a distinctive noun and a
    // room is not enough; the fault itself has to look the same, or the panel
    // would fire on everything and be ignored.
    const noun = uniqueNoun()
    await signIn(page, ACCOUNTS.employee)
    await openIncidents(page)
    await reportIncident(page, `The ${noun} will not power on in meeting room 3A`)

    await page.getByRole('button', { name: 'Report incident' }).click()
    const dialog = page.getByRole('dialog')
    // Measured at ~0.48, comfortably under the 0.55 threshold.
    await dialog.getByLabel('Title').fill(`The ${noun} in 3A is making a grinding noise`)
    await dialog.getByLabel('What is wrong?').fill('A different fault on the same unit.')

    // Long enough for the debounce and the round trip to have happened.
    await page.waitForTimeout(3000)
    await expect(page.getByTestId('similar-incidents')).toHaveCount(0)
  })

  test('an employee is told a colleague reported it without being shown their ticket', async ({ page }) => {
    const noun = uniqueNoun()

    // The admin's own incidents are outside what an employee may read.
    await signIn(page, ACCOUNTS.admin)
    await openIncidents(page)
    await reportIncident(page, `The ${noun} on level 2 is leaking water`)

    await signIn(page, ACCOUNTS.employee)
    await openIncidents(page)
    await page.getByRole('button', { name: 'Report incident' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Title').fill(`Water leaking from the ${noun} on level 2`)

    const panel = page.getByTestId('similar-incidents')
    await expect(panel).toBeVisible({ timeout: 15_000 })
    // Existence is disclosed, because that is the entire point of the feature.
    await expect(panel.getByText(new RegExp(noun, 'i')).first()).toBeVisible()
    // Ownership and contents are not. Matched against `.first()` because a
    // shared database accumulates incidents across runs and the panel may show
    // several, all of them equally unreadable to this employee.
    await expect(panel.getByText(/Reported by someone else/).first()).toBeVisible()
    // Not one of them offers a link, which would 404 if followed.
    await expect(panel.getByRole('link')).toHaveCount(0)
  })

  test('a triager sees the duplicates gathered on the incident itself', async ({ page }) => {
    const noun = uniqueNoun()
    await signIn(page, ACCOUNTS.employee)
    await openIncidents(page)
    const first = `The ${noun} on level 2 keeps tripping the breaker`
    await reportIncident(page, first)
    await reportIncident(page, `Breaker trips whenever the ${noun} runs on level 2`)

    await openIncidents(page)
    await page.getByLabel('Search').fill(first)
    await page.getByText(first).click()
    await expect(page.getByRole('heading', { name: first })).toBeVisible()

    const panel = page.getByTestId('similar-incidents')
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByText(/similar incident/).first()).toBeVisible()
    // An incident is never its own duplicate.
    await expect(panel.getByText(first, { exact: false })).toHaveCount(0)
  })
})

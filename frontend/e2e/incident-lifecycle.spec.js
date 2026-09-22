import { expect, test } from '@playwright/test'
import { ACCOUNTS, openIncidents, reportIncident, signIn } from './helpers'

/**
 * Each test creates the incident it needs, so the specs are independent and
 * can be run individually or retried. Titles carry a timestamp and a random
 * suffix so repeated runs against the same database never collide.
 *
 * Assertions prefer durable page state over the toast, which auto-hides after
 * a few seconds and makes a slow run fail for the wrong reason.
 *
 * @param {string} label Short description of the incident's purpose.
 * @returns {string} A unique title.
 */
const uniqueTitle = (label) =>
  `E2E ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

/**
 * Open an incident by its exact title from the list.
 *
 * @param {import('@playwright/test').Page} page The page under test.
 * @param {string} title The incident's title.
 */
async function openByTitle(page, title) {
  await openIncidents(page)
  await page.getByLabel('Search').fill(title)
  await page.getByText(title).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

test('an incident travels the full lifecycle across all three personas', async ({ page }) => {
  const title = uniqueTitle('projector fault')

  await test.step('an employee reports it', async () => {
    await signIn(page, ACCOUNTS.employee)
    await openIncidents(page)
    await reportIncident(page, title)
    await openByTitle(page, title)
    await expect(page.getByText('Open', { exact: true }).first()).toBeVisible()
  })

  await test.step('a facility admin assigns it, which stamps acknowledgement', async () => {
    await signIn(page, ACCOUNTS.admin)
    await openByTitle(page, title)
    await page.getByLabel('Assigned engineer').click()
    await page.getByRole('option').filter({ hasText: 'Sam Okafor' }).click()
    // Durable state, rather than the toast: the assignee and the stamp persist.
    await expect(page.getByText('Sam Okafor').first()).toBeVisible()
    await expect(page.getByText('Acknowledged')).toBeVisible()
  })

  await test.step('the assigned engineer starts work', async () => {
    await signIn(page, ACCOUNTS.engineer)
    await openByTitle(page, title)
    await page.getByLabel('Move to').click()
    await page.getByRole('option', { name: 'In Progress' }).click()
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByLabel('Move to')).toBeVisible()
  })

  await test.step('blocking demands a reason, which is recorded', async () => {
    await page.getByLabel('Move to').click()
    await page.getByRole('option', { name: 'Blocked' }).click()
    // The API rejects a block with no reason, so the UI must not offer to send one.
    await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled()
    await page.getByLabel('Why is it blocked?').fill('Replacement lamp on back-order')
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Replacement lamp on back-order' }),
    ).toBeVisible()
  })

  await test.step('it unblocks and resolves', async () => {
    await page.getByLabel('Move to').click()
    await page.getByRole('option', { name: 'In Progress' }).click()
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Blocked:' })).toHaveCount(0)

    await page.getByLabel('Move to').click()
    await page.getByRole('option', { name: 'Resolved' }).click()
    await page.getByLabel('How was it resolved?').fill('Swapped the projector lamp')
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Swapped the projector lamp' }),
    ).toBeVisible()
  })

  await test.step('the reporter confirms the fix by closing it', async () => {
    await signIn(page, ACCOUNTS.employee)
    await openByTitle(page, title)
    await page.getByLabel('Move to').click()
    await page.getByRole('option', { name: 'Closed' }).click()
    await page.getByRole('button', { name: 'Apply' }).click()
    // A closed incident is read-only.
    await expect(page.getByText(/notes can no longer be added/)).toBeVisible()
  })
})

test('notes carry the conversation, and internal notes stay internal', async ({ page }) => {
  const title = uniqueTitle('note thread')

  await signIn(page, ACCOUNTS.employee)
  await openIncidents(page)
  await reportIncident(page, title)
  await openByTitle(page, title)

  await page.getByLabel('Add a note').fill('It started on Monday morning.')
  await page.getByRole('button', { name: 'Post note' }).click()
  await expect(page.getByText('It started on Monday morning.')).toBeVisible()
  // An employee is not offered the internal-note switch at all.
  await expect(page.getByLabel('Internal note')).toHaveCount(0)

  await signIn(page, ACCOUNTS.admin)
  await openByTitle(page, title)
  await expect(page.getByText('It started on Monday morning.')).toBeVisible()
  await page.getByLabel('Add a note').fill('Triage: route to AV.')
  await page.getByLabel('Internal note').check()
  await page.getByRole('button', { name: 'Post note' }).click()
  await expect(page.getByText('Triage: route to AV.')).toBeVisible()

  await signIn(page, ACCOUNTS.employee)
  await openByTitle(page, title)
  await expect(page.getByText('It started on Monday morning.')).toBeVisible()
  await expect(page.getByText('Triage: route to AV.')).toHaveCount(0)
})

test('a reporter escalates and only a facility admin can clear it', async ({ page }) => {
  const title = uniqueTitle('escalation')

  await signIn(page, ACCOUNTS.employee)
  await openIncidents(page)
  await reportIncident(page, title)
  await openByTitle(page, title)

  await page.getByRole('button', { name: 'Escalate' }).click()
  await page.getByLabel('Why does this need escalating?').fill('Blocking a client demo tomorrow')
  await page.getByRole('dialog').getByRole('button', { name: 'Escalate' }).click()

  await expect(page.getByText('This incident is escalated.')).toBeVisible()
  await expect(page.getByText('Only a facility admin can clear an escalation.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear escalation' })).toHaveCount(0)

  await signIn(page, ACCOUNTS.admin)
  await openByTitle(page, title)
  await page.getByRole('button', { name: 'Clear escalation' }).click()
  await expect(page.getByText('This incident is escalated.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Escalate' })).toBeVisible()
})

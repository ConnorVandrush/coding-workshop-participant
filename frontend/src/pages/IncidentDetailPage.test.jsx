/**
 * Tests for the incident detail page.
 *
 * This is where the workflow, assignment and the note thread meet, and where
 * the UI mirrors the API's permissions so no control leads to a 403. The API
 * stays the authority; these tests check the page does not offer dead ends.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IncidentDetailPage from './IncidentDetailPage';
import { ADMIN, EMPLOYEE, ENGINEER, mockApi, renderPage } from '../test/utils';

const reporter = { id: 2, user_id: 2, full_name: 'Dana Ruiz', email: 'dana.ruiz@acme.inc' };
const assignee = { id: 5, user_id: 3, full_name: 'Sam Okafor', email: 'sam.okafor@acme.inc' };

const incident = (overrides = {}) => ({
  id: 42,
  title: 'Projector will not power on',
  description: 'Meeting room 3A projector is dead since Monday.',
  category: 'AV_EQUIPMENT',
  priority: 'HIGH',
  status: 'IN_PROGRESS',
  is_escalated: false,
  escalation_note: null,
  blocked_reason: null,
  resolution: null,
  reporter,
  assignee,
  location: { building_id: 1, building_name: 'HQ North', floor_id: 3, floor_level: 3, seat_id: 7, seat_code: '3A-12' },
  note_count: 1,
  allowed_transitions: ['BLOCKED', 'RESOLVED', 'OPEN'],
  created_at: '2026-09-22T10:00:00Z',
  updated_at: '2026-09-22T11:30:00Z',
  acknowledged_at: '2026-09-22T10:20:00Z',
  assigned_at: '2026-09-22T10:20:00Z',
  resolved_at: null,
  closed_at: null,
  ...overrides,
});

const notes = [{
  id: 1, incident_id: 42, author: reporter,
  body: 'Tried a different HDMI cable, no change.', is_internal: false,
  created_at: '2026-09-22T10:05:00Z',
}];

const equipment = [{
  id: 4, code: 'AV-3A-PROJ-01', name: 'Ceiling projector, Meeting Room 3A',
  asset_type: 'PROJECTOR', building_id: 1, building_name: 'HQ North',
  floor_id: 3, floor_level: 3, seat_id: 7, seat_code: '3A-12',
  installed_on: '2020-07-14', expected_life_months: 60,
  service_interval_months: 12, last_serviced_on: '2024-01-10',
  next_service_due: '2025-01-10', service_status: 'overdue', days_until_service: -620,
  retired_on: null, is_retired: false, notes: null,
  incident_count: 4, open_incident_count: 1, last_incident_at: '2026-09-22T10:00:00Z',
  created_at: '2026-09-01T09:00:00Z',
}];

const engineers = [{
  id: 5, user_id: 3, email: 'sam.okafor@acme.inc', full_name: 'Sam Okafor',
  specialties: ['AV_EQUIPMENT'], phone: null, is_available: true,
  max_active_incidents: 8, active_incidents: 3, has_capacity: true,
  created_at: '2026-09-01T09:00:00Z',
}];

const workflow = { statuses: [{ id: 'OPEN', label: 'Open', is_terminal: false }], transitions: [] };

/**
 * Stub the endpoints the detail page loads.
 *
 * @param {object} [overrides] Extra or replacement handlers.
 * @returns {import('vitest').Mock} The fetch stub.
 */
const api = (overrides = {}) => mockApi({
  'GET /incidents/:id': incident(),
  'GET /incidents/:id/notes': notes,
  'GET /incidents/:id/related': { matches: [] },
  'GET /engineers': engineers,
  'GET /assets': equipment,
  'GET /workflow': workflow,
  ...overrides,
});

/**
 * Render the page at the detail route.
 *
 * @param {object} user The signed-in persona.
 * @returns {object} The render result.
 */
const renderDetail = (user) =>
  renderPage(<IncidentDetailPage />, { user, route: '/incidents/42', path: '/incidents/:incidentId' });

afterEach(() => vi.unstubAllGlobals());

describe('rendering', () => {
  it('shows the incident and its resolved location', async () => {
    api();
    renderDetail(ADMIN);
    expect(await screen.findByText('Projector will not power on')).toBeInTheDocument();
    expect(screen.getByText('HQ North · Level 3 · 3A-12')).toBeInTheDocument();
    expect(screen.getByText('Av Equipment')).toBeInTheDocument();
  });

  it('says so plainly when nobody is assigned', async () => {
    api({ 'GET /incidents/:id': incident({ assignee: null }) });
    renderDetail(ADMIN);
    expect(await screen.findByText('Nobody yet')).toBeInTheDocument();
  });

  it('highlights a blocking reason', async () => {
    api({ 'GET /incidents/:id': incident({ status: 'BLOCKED', blocked_reason: 'Lamp on back-order' }) });
    renderDetail(ADMIN);
    expect(await screen.findByText(/Lamp on back-order/)).toBeInTheDocument();
  });

  it('renders the note thread', async () => {
    api();
    renderDetail(ADMIN);
    expect(await screen.findByText('Tried a different HDMI cable, no change.')).toBeInTheDocument();
    expect(screen.getByText('Notes (1)')).toBeInTheDocument();
  });

  it('explains an incident that is missing or out of scope', async () => {
    api({
      'GET /incidents/:id': {
        status: 404,
        body: { error: { status: 404, type: 'not_found', message: 'Incident 42 was not found', details: null } },
      },
    });
    renderDetail(EMPLOYEE);
    expect(await screen.findByText(/does not exist, or it is outside what your role can see/)).toBeInTheDocument();
  });
});

describe('controls mirror the API permissions', () => {
  it('offers assignment and status controls to a facility admin', async () => {
    api();
    renderDetail(ADMIN);
    expect(await screen.findByText('Assignment')).toBeInTheDocument();
    expect(screen.getByText('Change status')).toBeInTheDocument();
  });

  it('hides the assignment panel from an employee', async () => {
    api();
    renderDetail(EMPLOYEE);
    await screen.findByText('Projector will not power on');
    expect(screen.queryByText('Assignment')).not.toBeInTheDocument();
  });

  it('hides the assignment panel from an engineer, who cannot assign work', async () => {
    api();
    renderDetail(ENGINEER);
    await screen.findByText('Projector will not power on');
    expect(screen.queryByText('Assignment')).not.toBeInTheDocument();
    // The engineer still drives the work they were given.
    expect(screen.getByText('Change status')).toBeInTheDocument();
  });

  it('offers only the transitions the API says are legal', async () => {
    api();
    renderDetail(ADMIN);
    await screen.findByText('Change status');

    await userEvent.click(screen.getByLabelText('Move to'));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['Choose a status', 'Blocked', 'Resolved', 'Open']);
    expect(options).not.toContain('Closed');
  });

  it('lets only a facility admin clear an escalation', async () => {
    api({ 'GET /incidents/:id': incident({ is_escalated: true }) });
    renderDetail(EMPLOYEE);
    await screen.findByText('This incident is escalated.');
    expect(screen.queryByRole('button', { name: /Clear escalation/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Only a facility admin can clear an escalation/)).toBeInTheDocument();
  });

  it('shows the delete control to an admin only', async () => {
    api();
    renderDetail(ADMIN);
    expect(await screen.findByLabelText('Delete incident')).toBeInTheDocument();
  });

  it('hides the delete control from an engineer', async () => {
    api();
    renderDetail(ENGINEER);
    await screen.findByText('Projector will not power on');
    expect(screen.queryByLabelText('Delete incident')).not.toBeInTheDocument();
  });
});

describe('driving the workflow', () => {
  it('demands a reason before blocking', async () => {
    api();
    renderDetail(ADMIN);
    await screen.findByText('Change status');

    await userEvent.click(screen.getByLabelText('Move to'));
    await userEvent.click(await screen.findByRole('option', { name: 'Blocked' }));

    // The API rejects a block with no reason, so the UI must not offer to send one.
    expect(screen.getByRole('button', { name: /Apply/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Why is it blocked/), 'Lamp on back-order');
    expect(screen.getByRole('button', { name: /Apply/i })).toBeEnabled();
  });

  it('posts the reason with the transition', async () => {
    const fetchMock = api({
      'POST /incidents/:id/status': incident({ status: 'BLOCKED', blocked_reason: 'Lamp on back-order' }),
    });
    renderDetail(ADMIN);
    await screen.findByText('Change status');

    await userEvent.click(screen.getByLabelText('Move to'));
    await userEvent.click(await screen.findByRole('option', { name: 'Blocked' }));
    await userEvent.type(screen.getByLabelText(/Why is it blocked/), 'Lamp on back-order');
    await userEvent.click(screen.getByRole('button', { name: /Apply/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) =>
        init?.method === 'POST' && String(url).endsWith('/status'));
      expect(JSON.parse(post[1].body)).toEqual({ status: 'BLOCKED', reason: 'Lamp on back-order' });
    });
  });

  it('surfaces a rejected transition', async () => {
    api({
      'POST /incidents/:id/status': {
        status: 409,
        body: { error: { status: 409, type: 'invalid_transition', message: 'Cannot move an incident from IN_PROGRESS to CLOSED', details: null } },
      },
    });
    renderDetail(ADMIN);
    await screen.findByText('Change status');

    await userEvent.click(screen.getByLabelText('Move to'));
    await userEvent.click(await screen.findByRole('option', { name: 'Open' }));
    await userEvent.click(screen.getByRole('button', { name: /Apply/i }));

    expect(await screen.findByText(/Cannot move an incident/)).toBeInTheDocument();
  });
});

describe('notes', () => {
  it('posts a note and shows it in the thread', async () => {
    const fetchMock = api({
      'POST /incidents/:id/notes': {
        status: 201,
        body: { id: 2, incident_id: 42, author: ADMIN, body: 'Ordered a replacement lamp.', is_internal: false, created_at: '2026-09-22T12:00:00Z' },
      },
    });
    renderDetail(ADMIN);
    await screen.findByText('Notes (1)');

    await userEvent.type(screen.getByLabelText(/Add a note/), 'Ordered a replacement lamp.');
    await userEvent.click(screen.getByRole('button', { name: /Post note/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) =>
        init?.method === 'POST' && String(url).endsWith('/notes'));
      expect(JSON.parse(post[1].body)).toEqual({ body: 'Ordered a replacement lamp.', is_internal: false });
    });
    expect(await screen.findByText('Note added')).toBeInTheDocument();
  });

  it('offers the internal-note switch to staff but not to employees', async () => {
    api();
    const { unmount } = renderDetail(ADMIN);
    expect(await screen.findByLabelText('Internal note')).toBeInTheDocument();
    unmount();

    renderDetail(EMPLOYEE);
    await screen.findByLabelText(/Add a note/);
    expect(screen.queryByLabelText('Internal note')).not.toBeInTheDocument();
  });

  it('closes the thread once the incident is closed', async () => {
    api({ 'GET /incidents/:id': incident({ status: 'CLOSED', allowed_transitions: ['OPEN'] }) });
    renderDetail(ADMIN);
    expect(await screen.findByText(/notes can no longer be added/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Add a note/)).not.toBeInTheDocument();
  });
});

describe('assignment', () => {
  // A plumber and an AV engineer, against an incident filed as AV_EQUIPMENT.
  const roster = [
    { ...engineers[0], id: 6, user_id: 4, full_name: 'Priya Raman', specialties: ['PLUMBING'] },
    engineers[0],
  ];

  it('offers the engineers who specialise in the incident first', async () => {
    api({ 'GET /engineers': roster, 'GET /incidents/:id': incident({ assignee: null }) });
    renderDetail(ADMIN);
    await screen.findByText('Assignment');

    await userEvent.click(screen.getByLabelText('Assigned engineer'));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Unassigned',
      expect.stringContaining('Sam Okafor'),
      expect.stringContaining('Priya Raman'),
    ]);
    // The headings label the two groups without becoming choices themselves.
    expect(screen.getByText('Specialises in Av Equipment')).toBeInTheDocument();
    expect(screen.getByText('Other engineers')).toBeInTheDocument();
    expect(options[1]).toHaveTextContent('specialises in Av Equipment');
    expect(options[2]).not.toHaveTextContent('specialises in');
  });

  it('leaves the roster ungrouped when nobody specialises in the incident', async () => {
    api({
      'GET /engineers': [roster[0]],
      'GET /incidents/:id': incident({ assignee: null }),
    });
    renderDetail(ADMIN);
    await screen.findByText('Assignment');

    await userEvent.click(screen.getByLabelText('Assigned engineer'));
    expect(await screen.findByRole('option', { name: /Priya Raman/ })).toBeInTheDocument();
    expect(screen.queryByText('Other engineers')).not.toBeInTheDocument();
  });

  it('marks an engineer at capacity as unselectable', async () => {
    api({
      'GET /engineers': [{ ...engineers[0], active_incidents: 8, has_capacity: false }],
      'GET /incidents/:id': incident({ assignee: null }),
    });
    renderDetail(ADMIN);
    await screen.findByText('Assignment');

    await userEvent.click(screen.getByLabelText('Assigned engineer'));
    const option = await screen.findByRole('option', { name: /at capacity/ });
    expect(option).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('related incidents', () => {
  const related = (overrides = {}) => ({
    id: 77,
    title: 'Air conditioning leaking over desks on level 2',
    category: 'HVAC',
    priority: 'CRITICAL',
    status: 'OPEN',
    location: { building_id: 1, building_name: 'HQ North', floor_id: 10, floor_level: 2, seat_id: null, seat_code: null },
    created_at: '2026-09-20T08:00:00Z',
    score: 0.81,
    reasons: ['wording is very similar', 'same category', 'same floor'],
    visible: true,
    ...overrides,
  });

  it('shows incidents that look like the same fault', async () => {
    api({ 'GET /incidents/:id/related': { matches: [related()] } });
    renderDetail();
    expect(await screen.findByTestId('similar-incidents')).toBeInTheDocument();
    expect(screen.getByText(/#77 Air conditioning leaking/)).toBeInTheDocument();
  });

  it('presents them as information rather than a warning', async () => {
    // Nothing is being drafted here, so there is no "you may not need to
    // report this" advice to give - that copy belongs to the report dialog.
    api({ 'GET /incidents/:id/related': { matches: [related()] } });
    renderDetail();
    await screen.findByTestId('similar-incidents');
    expect(screen.queryByText(/This may already be reported/)).not.toBeInTheDocument();
  });

  it('shows nothing when the incident stands alone', async () => {
    api();
    renderDetail();
    await screen.findByText('Projector will not power on');
    expect(screen.queryByTestId('similar-incidents')).not.toBeInTheDocument();
  });

  it('stays quiet when the lookup fails', async () => {
    api({
      'GET /incidents/:id/related': {
        status: 503,
        body: { error: { status: 503, type: 'database_unavailable', message: 'nope', details: null } },
      },
    });
    renderDetail();
    await screen.findByText('Projector will not power on');
    expect(screen.queryByTestId('similar-incidents')).not.toBeInTheDocument();
    expect(screen.queryByText(/nope/)).not.toBeInTheDocument();
  });
});

describe('attributing a fault to a unit', () => {
  it('shows the unit an incident was filed against', async () => {
    api({ 'GET /incidents/:id': incident({ asset: { id: 4, code: 'AV-3A-PROJ-01', name: 'Ceiling projector, Meeting Room 3A', asset_type: 'PROJECTOR' } }) });
    renderDetail(ADMIN);
    expect(await screen.findByText('AV-3A-PROJ-01 — Ceiling projector, Meeting Room 3A')).toBeInTheDocument();
  });

  it('lets a facility admin attribute an incident that was filed without one', async () => {
    const fetchMock = api({ 'GET /incidents/:id': incident({ asset: null }) });
    renderDetail(ADMIN);
    // "Equipment" appears twice - as a fact and as this panel's heading - so
    // the control itself is what the test waits for.
    await screen.findByLabelText('Failed unit');

    await userEvent.click(screen.getByLabelText('Failed unit'));
    await userEvent.click(await screen.findByRole('option', { name: /AV-3A-PROJ-01/ }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put[1].body).asset_id).toBe(4);
    });
  });

  it('hides the control from an employee who is not the reporter', async () => {
    api();
    renderDetail(EMPLOYEE);
    await screen.findByText('Projector will not power on');
    expect(screen.queryByLabelText('Failed unit')).not.toBeInTheDocument();
  });
});

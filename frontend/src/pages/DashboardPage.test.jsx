/**
 * Tests for the dashboard.
 *
 * The same panels render for every persona because the API scopes the numbers,
 * so what matters here is that the page reflects the scope it was given, shows
 * management-only information to admins alone, and that the drill-down tiles
 * actually apply a filter before navigating.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DashboardPage from './DashboardPage';
import { ADMIN, EMPLOYEE, mockApi, renderPage } from '../test/utils';

const summary = (scope, overrides = {}) => ({
  scope,
  total: 24,
  open_total: 16,
  escalated_total: 4,
  unassigned_total: 7,
  by_status: [{ key: 'OPEN', count: 10 }, { key: 'BLOCKED', count: 2 }],
  by_priority: [{ key: 'LOW', count: 9 }, { key: 'CRITICAL', count: 2 }],
  by_category: [{ key: 'HVAC', count: 3 }, { key: 'AV_EQUIPMENT', count: 2 }],
  ...overrides,
});

const hotspots = {
  buildings: [{ id: 1, label: 'HQ North', count: 14, open_count: 10 }],
  floors: [{ id: 3, label: 'HQ North - Level 3', count: 6, open_count: 5 }],
  seats: [{ id: 7, label: 'HQ North - Level 3 - 3A-12', count: 2, open_count: 2 }],
};

const sla = {
  acknowledged_hours_avg: 1.8, assigned_hours_avg: 2.4,
  resolved_hours_avg: 26.5, closed_hours_avg: null,
  resolved_count: 8, sample_size: 24,
};

const workload = [{
  engineer_id: 1, full_name: 'Nora Feld', email: 'nora@acme.inc',
  is_available: true, max_active_incidents: 6, active: 4, resolved: 2, closed: 0, escalated: 3,
}];

const workflow = {
  statuses: [
    { id: 'OPEN', label: 'Open', is_terminal: false },
    { id: 'IN_PROGRESS', label: 'In Progress', is_terminal: false },
    { id: 'CLOSED', label: 'Closed', is_terminal: true },
  ],
  transitions: [{ from: 'OPEN', to: 'IN_PROGRESS' }],
};

/**
 * Stub the five endpoints the dashboard loads.
 *
 * @param {string} scope Role the API should report as the scope.
 * @param {boolean} includeWorkload Whether the workload endpoint answers.
 * @returns {import('vitest').Mock} The fetch stub.
 */
const api = (scope, includeWorkload = true) => mockApi({
  'GET /dashboard/summary': summary(scope),
  'GET /dashboard/hotspots': hotspots,
  'GET /dashboard/sla': sla,
  'GET /dashboard/engineers': includeWorkload
    ? workload
    : { status: 403, body: { error: { status: 403, type: 'forbidden', message: 'no', details: null } } },
  'GET /workflow': workflow,
});

/**
 * Find a headline tile by its label.
 *
 * Several labels and values also appear in the work-distribution table, so the
 * lookup deliberately skips anything inside a table cell.
 *
 * @param {string} label The tile's caption, e.g. `Escalated`.
 * @returns {HTMLElement} The tile's card element.
 */
function statTile(label) {
  const caption = screen.getAllByText(label).find((node) => !node.closest('th') && !node.closest('td'));
  return caption.closest('.MuiCard-root');
}

afterEach(() => vi.unstubAllGlobals());

describe('headline figures', () => {
  it('names the scope the API reported', async () => {
    api('facility_admin');
    renderPage(<DashboardPage />);
    expect(await screen.findByText('Facility Admin overview')).toBeInTheDocument();
    expect(screen.getByText('Every incident across the estate.')).toBeInTheDocument();
  });

  it('renders each counter against its own label', async () => {
    api('facility_admin');
    renderPage(<DashboardPage />);
    await screen.findByText('Facility Admin overview');

    expect(within(statTile('Total')).getByText('24')).toBeInTheDocument();
    expect(within(statTile('Still active')).getByText('16')).toBeInTheDocument();
    expect(within(statTile('Escalated')).getByText('4')).toBeInTheDocument();
    expect(within(statTile('Unassigned')).getByText('7')).toBeInTheDocument();
  });

  it('describes an employee scope differently', async () => {
    api('employee', false);
    renderPage(<DashboardPage />, { user: EMPLOYEE });
    expect(await screen.findByText('Employee overview')).toBeInTheDocument();
    expect(screen.getByText('Incidents you have reported.')).toBeInTheDocument();
  });
});

describe('breakdowns and panels', () => {
  it('humanises enum keys rather than showing raw values', async () => {
    api('facility_admin');
    renderPage(<DashboardPage />);
    expect(await screen.findByText('Av Equipment')).toBeInTheDocument();
    expect(screen.getByText('Hvac')).toBeInTheDocument();
  });

  it('renders the workflow diagram from the API graph', async () => {
    api('facility_admin');
    renderPage(<DashboardPage />);
    expect(await screen.findByText('Ticket workflow')).toBeInTheDocument();
    expect(screen.getByText(/1 transitions defined/)).toBeInTheDocument();
  });

  it('ranks hotspots and keeps the full label available on hover', async () => {
    api('facility_admin');
    renderPage(<DashboardPage />);
    const seat = await screen.findByText('HQ North - Level 3 - 3A-12');
    // Long seat labels truncate visually, so the full text must stay reachable.
    expect(seat).toHaveAttribute('title', 'HQ North - Level 3 - 3A-12');
  });

  it('shows an em dash for a response time the API could not compute', async () => {
    api('facility_admin');
    renderPage(<DashboardPage />);
    expect(await screen.findByText('26.5 h avg')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('role scoping', () => {
  it('shows work distribution to a facility admin', async () => {
    api('facility_admin');
    renderPage(<DashboardPage />, { user: ADMIN });
    expect(await screen.findByText('Work distribution')).toBeInTheDocument();
    expect(screen.getByText('Nora Feld')).toBeInTheDocument();
  });

  it('hides work distribution from an employee', async () => {
    api('employee', false);
    renderPage(<DashboardPage />, { user: EMPLOYEE });
    await screen.findByText('Employee overview');
    expect(screen.queryByText('Work distribution')).not.toBeInTheDocument();
  });
});

describe('drill-down', () => {
  it('applies a filter and navigates when a counter is clicked', async () => {
    api('facility_admin');
    const { store } = renderPage(<DashboardPage />);
    await screen.findByText('Facility Admin overview');

    await userEvent.click(statTile('Escalated'));

    await waitFor(() => expect(screen.getByText('incidents list page')).toBeInTheDocument());
    expect(store.getState().incidents.filters.is_escalated).toBe('true');
  });

  it('filters by status when a breakdown row is clicked', async () => {
    api('facility_admin');
    const { store } = renderPage(<DashboardPage />);
    await screen.findByText('Facility Admin overview');

    await userEvent.click(screen.getByText('Blocked'));

    await waitFor(() => expect(store.getState().incidents.filters.status).toBe('BLOCKED'));
  });
});

describe('failure', () => {
  it('surfaces an error instead of rendering an empty dashboard', async () => {
    mockApi({
      'GET /dashboard/summary': { status: 500, body: { error: { status: 500, type: 'internal_error', message: 'Database unavailable', details: null } } },
      'GET /dashboard/hotspots': hotspots,
      'GET /dashboard/sla': sla,
      'GET /workflow': workflow,
    });
    renderPage(<DashboardPage />);
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
  });
});

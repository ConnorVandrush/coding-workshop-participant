/**
 * Tests for the maintenance screen.
 *
 * The page exists to justify spending money, so what matters is that it never
 * asserts more than the API told it: a flagged unit shows the reasons it was
 * flagged, a thin evidence base is called out rather than glossed over, and the
 * controls that write to the register only appear for the persona allowed to
 * use them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MaintenancePage from './MaintenancePage';
import { ADMIN, ENGINEER, mockApi, renderPage } from '../test/utils';

const summary = (overrides = {}) => ({
  assets_tracked: 16,
  assets_retired: 1,
  assets_needing_review: 2,
  assets_past_expected_life: 1,
  assets_service_overdue: 3,
  assets_service_due_soon: 2,
  assets_without_service_interval: 4,
  incidents_total: 29,
  incidents_linked: 19,
  linked_percent: 65.5,
  ...overrides,
});

const review = {
  window_days: 90,
  items: [
    {
      id: 4, code: 'AV-3A-PROJ-01', name: 'Ceiling projector, Meeting Room 3A',
      asset_type: 'PROJECTOR', location: 'HQ North - Level 3 - 3A-12',
      installed_on: '2020-07-14', age_years: 6.2,
      incident_count: 4, open_incident_count: 1, recent_incident_count: 4,
      last_incident_at: '2026-09-22T10:00:00Z', days_between_failures: 61.2,
      type_median_incidents: 1.0, needs_review: true,
      next_service_due: '2025-01-10', service_status: 'overdue', days_until_service: -620,
      reasons: ['4 failures in the last 90 days', 'past its expected service life',
                'service overdue by 620 days'],
    },
    {
      id: 9, code: 'HQ-1B-TAP-02', name: 'Cafeteria mixer tap',
      asset_type: 'PLUMBING_FIXTURE', location: 'HQ North - Level 1 - 1B-07',
      installed_on: '2023-05-01', age_years: 3.4,
      incident_count: 1, open_incident_count: 0, recent_incident_count: 1,
      last_incident_at: '2026-09-01T10:00:00Z', days_between_failures: null,
      type_median_incidents: 1.0, needs_review: false, reasons: [],
      next_service_due: null, service_status: 'unknown', days_until_service: null,
    },
  ],
};

const types = [
  { asset_type: 'PROJECTOR', asset_count: 3, incident_count: 6, open_incident_count: 2,
    incidents_per_asset: 2.0, review_count: 1, avg_age_years: 3.1 },
];

const hotspots = {
  buildings: [{ id: 1, label: 'HQ North', count: 14, open_count: 10 }],
  floors: [{ id: 3, label: 'HQ North - Level 3', count: 6, open_count: 5 }],
  seats: [{ id: 7, label: 'HQ North - Level 3 - 3A-12', count: 2, open_count: 2 }],
};

const assets = [{
  id: 4, code: 'AV-3A-PROJ-01', name: 'Ceiling projector, Meeting Room 3A',
  asset_type: 'PROJECTOR', manufacturer: 'Epson', model: 'EB-L200',
  building_id: 1, building_name: 'HQ North', floor_id: 3, floor_level: 3,
  seat_id: 7, seat_code: '3A-12', installed_on: '2020-07-14',
  expected_life_months: 60, retired_on: null, is_retired: false, notes: null,
  service_interval_months: 12, last_serviced_on: '2024-01-10',
  next_service_due: '2025-01-10', service_status: 'overdue', days_until_service: -620,
  incident_count: 4, open_incident_count: 1, last_incident_at: '2026-09-22T10:00:00Z',
  created_at: '2026-09-01T09:00:00Z',
}];

/**
 * Stub the endpoints the maintenance screen loads.
 *
 * @param {object} [overrides] Extra or replacement handlers.
 * @returns {import('vitest').Mock} The fetch stub.
 */
const api = (overrides = {}) => mockApi({
  'GET /maintenance/summary': summary(),
  'GET /maintenance/assets/review': review,
  'GET /maintenance/types': types,
  'GET /dashboard/hotspots': hotspots,
  'GET /assets': assets,
  'GET /buildings': [{ id: 1, name: 'HQ North', address: null, floor_count: 1, created_at: '2026-09-01T09:00:00Z' }],
  ...overrides,
});

/**
 * Find a headline tile by its caption.
 *
 * @param {string} label The tile's caption, e.g. `Service overdue`.
 * @returns {HTMLElement} The tile's card element.
 */
const statTile = (label) => screen.getByText(label).closest('.MuiCard-root');

afterEach(() => vi.unstubAllGlobals());

describe('headline figures', () => {
  it('reports the register and the coverage behind every other number', async () => {
    api();
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    expect(await screen.findByText('16')).toBeInTheDocument();
    expect(screen.getByText('65.5%')).toBeInTheDocument();
    expect(screen.getByText('19 of 29 name a unit')).toBeInTheDocument();
  });

  it('warns when too little of the record is attributed to equipment', async () => {
    api({ 'GET /maintenance/summary': summary({ linked_percent: 21.0, incidents_linked: 6 }) });
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    expect(await screen.findByText(/Fewer than half of all incidents name a unit/)).toBeInTheDocument();
  });

  it('stays quiet about coverage when most incidents do name a unit', async () => {
    api();
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    await screen.findByText('65.5%');
    expect(screen.queryByText(/Fewer than half of all incidents/)).not.toBeInTheDocument();
  });
});

describe('units to review', () => {
  it('shows the reasons a unit was flagged, not just that it was', async () => {
    api();
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    const table = await screen.findByRole('table', { name: 'Units to review' });
    expect(within(table).getByText('AV-3A-PROJ-01')).toBeInTheDocument();
    expect(within(table).getByText('4 failures in the last 90 days')).toBeInTheDocument();
    expect(within(table).getByText('past its expected service life')).toBeInTheDocument();
  });

  it('lists only the units the rules actually flagged', async () => {
    api();
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    const table = await screen.findByRole('table', { name: 'Units to review' });
    // The tap came back in the same payload but met no rule.
    expect(within(table).queryByText('HQ-1B-TAP-02')).not.toBeInTheDocument();
  });

  it('says so plainly when nothing meets a rule', async () => {
    api({ 'GET /maintenance/assets/review': { window_days: 90, items: [review.items[1]] } });
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    expect(await screen.findByText(/No unit meets any of the review rules/)).toBeInTheDocument();
  });

  it('re-asks the API when the window changes', async () => {
    const fetchMock = api();
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    await screen.findByRole('table', { name: 'Units to review' });

    await userEvent.click(screen.getByLabelText('Window'));
    await userEvent.click(await screen.findByRole('option', { name: 'Last year' }));

    await waitFor(() => {
      const called = fetchMock.mock.calls.map(([url]) => String(url));
      expect(called.some((url) => url.includes('/maintenance/summary?window_days=365'))).toBe(true);
    });
  });
});

describe('the other panels', () => {
  it('ranks equipment classes by failures per unit', async () => {
    api();
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    const table = await screen.findByRole('table', { name: 'Reliability by equipment class' });
    expect(within(table).getByText('Projector')).toBeInTheDocument();
    expect(within(table).getByText('2')).toBeInTheDocument();
  });

  it('carries the hotspots that used to live on the dashboard', async () => {
    api();
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    // Scoped to the panel: the review table above states the same location for
    // the same unit, so an unscoped lookup would match both.
    const panel = await screen.findByRole('region', { name: 'Recurring issue hotspots' });
    const seat = within(panel).getByText('HQ North - Level 3 - 3A-12');
    // Long seat labels truncate visually, so the full text must stay reachable.
    expect(seat).toHaveAttribute('title', 'HQ North - Level 3 - 3A-12');
  });

});

describe('controls mirror the API permissions', () => {

  it('shows an engineer the figures but no way to change the register', async () => {
    api();
    renderPage(<MaintenancePage />, { user: ENGINEER, route: '/maintenance' });
    await screen.findByRole('table', { name: 'Units to review' });
    expect(screen.queryByRole('button', { name: 'Register equipment' })).not.toBeInTheDocument();
  });

  it('registers a unit and reloads the figures behind it', async () => {
    const fetchMock = api({ 'POST /assets': { status: 201, body: assets[0] } });
    renderPage(<MaintenancePage />, { user: ADMIN, route: '/maintenance' });

    await userEvent.click(await screen.findByRole('button', { name: 'Register equipment' }));
    await userEvent.type(screen.getByLabelText(/Asset tag/), 'AV-4A-PROJ-09');
    await userEvent.type(screen.getByLabelText(/^Class/), 'projector');
    await userEvent.type(screen.getByLabelText(/^Name/), 'Boardroom projector');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(posted).toBeTruthy();
      // Free text is normalised into the shape the register stores.
      expect(JSON.parse(posted[1].body).asset_type).toBe('PROJECTOR');
    });
    expect(await screen.findByText('Equipment registered')).toBeInTheDocument();
  });
});

describe('failure', () => {
  it('explains itself rather than rendering empty tables', async () => {
    api({
      'GET /maintenance/summary': {
        status: 500,
        body: { error: { status: 500, type: 'server_error', message: 'Database unavailable', details: null } },
      },
    });
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    expect(await screen.findByText(/Database unavailable/)).toBeInTheDocument();
  });
});

describe('servicing', () => {
  it('reports the service backlog beside the failure figures', async () => {
    api();
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    await screen.findByRole('table', { name: 'Units to review' });
    expect(within(statTile('Service overdue')).getByText('3')).toBeInTheDocument();
    expect(within(statTile('Due soon')).getByText('2')).toBeInTheDocument();
  });

  it('calls out units with no interval, which nothing can fall due for', async () => {
    api();
    renderPage(<MaintenancePage />, { route: '/maintenance' });
    expect(await screen.findByText(/4 units have no service interval set/)).toBeInTheDocument();
  });
});

/**
 * Tests for the incident list page.
 *
 * Covers the two things the page is responsible for: turning the stored
 * filters into a request the API accepts, and reporting a new incident.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IncidentsPage from './IncidentsPage';
import { ADMIN, EMPLOYEE, ENGINEER, mockApi, renderPage } from '../test/utils';
import { setFilters } from '../store/incidentsSlice';

vi.mock('react-responsive', () => ({ useMediaQuery: () => true }));

const incident = (id, title, overrides = {}) => ({
  id,
  title,
  category: 'AV_EQUIPMENT',
  priority: 'HIGH',
  status: 'OPEN',
  is_escalated: false,
  assignee: null,
  location: { building_name: 'HQ North', floor_level: 3, seat_code: '3A-12' },
  created_at: '2026-09-22T10:00:00Z',
  ...overrides,
});

const buildings = [
  { id: 1, name: 'HQ North', address: '1 Market St', floor_count: 4, created_at: '2026-09-01T09:00:00Z' },
];

const page = (items, total = items.length) => ({ items, total, limit: 25, offset: 0 });

/**
 * Stub the endpoints the list page uses.
 *
 * @param {object} [overrides] Extra or replacement handlers.
 * @returns {import('vitest').Mock} The fetch stub.
 */
const api = (overrides = {}) => mockApi({
  'GET /buildings': buildings,
  'GET /incidents': page([incident(42, 'Projector will not power on'), incident(43, 'AC leaking')]),
  // The report dialog asks this as the reporter types. Stubbed for every test
  // so a debounce that happens to fire is answered rather than 404ing.
  'POST /incidents/duplicate-check': { matches: [] },
  ...overrides,
});

/**
 * Find the call that reported an incident.
 *
 * Matched on the path as well as the method: the dialog also POSTs to
 * `/incidents/duplicate-check`, so filtering on the method alone can pick up
 * the duplicate lookup instead of the report.
 *
 * @param {import('vitest').Mock} fetchMock The fetch stub.
 * @returns {Array|undefined} The matching call arguments.
 */
const reportCall = (fetchMock) => fetchMock.mock.calls.find(
  ([url, init]) => init?.method === 'POST' && String(url).endsWith('/incidents'),
);

afterEach(() => vi.unstubAllGlobals());

describe('listing', () => {
  it('shows the API total, not the number of rows on this page', async () => {
    // These differ whenever the result set is longer than one page.
    api({ 'GET /incidents': page([incident(42, 'Projector will not power on')], 137) });
    renderPage(<IncidentsPage />);
    expect(await screen.findByText('137 matching incidents')).toBeInTheDocument();
  });

  it('renders the returned incidents', async () => {
    api();
    renderPage(<IncidentsPage />);
    expect(await screen.findByText('Projector will not power on')).toBeInTheDocument();
    expect(screen.getByText('AC leaking')).toBeInTheDocument();
  });

  it('uses the singular for a single match', async () => {
    api({ 'GET /incidents': page([incident(42, 'Only one')], 1) });
    renderPage(<IncidentsPage />);
    expect(await screen.findByText('1 matching incident')).toBeInTheDocument();
  });
});

describe('filtering', () => {
  it('sends the chosen status as a query parameter', async () => {
    const fetchMock = api();
    renderPage(<IncidentsPage />);
    await screen.findByText('Projector will not power on');

    await userEvent.click(screen.getByLabelText('Status'));
    await userEvent.click(await screen.findByRole('option', { name: 'Blocked' }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(urls.some((u) => u.includes('/incidents?') && u.includes('status=BLOCKED'))).toBe(true);
    });
  });

  it('never sends an empty filter, which the API would reject', async () => {
    const fetchMock = api();
    renderPage(<IncidentsPage />);
    await screen.findByText('Projector will not power on');

    const incidentCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((u) => u.includes('/incidents?'));
    expect(incidentCalls.length).toBeGreaterThan(0);
    incidentCalls.forEach((url) => {
      expect(url).not.toMatch(/[?&]status=(&|$)/);
      expect(url).not.toMatch(/[?&]priority=(&|$)/);
    });
  });

  it('clears every filter on demand', async () => {
    api();
    const { store } = renderPage(<IncidentsPage />);
    await screen.findByText('Projector will not power on');

    await userEvent.type(screen.getByLabelText('Search'), 'projector');
    await waitFor(() => expect(store.getState().incidents.filters.q).toBe('projector'));

    await userEvent.click(screen.getByRole('button', { name: /Clear filters/i }));
    expect(store.getState().incidents.filters.q).toBe('');
  });
});

describe('reporting an incident', () => {
  it('requires a title and a description before submitting', async () => {
    api();
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    await screen.findByText('Projector will not power on');

    await userEvent.click(screen.getByRole('button', { name: /Report incident/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /^Report$/i })).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Desk light flickering');
    expect(within(dialog).getByRole('button', { name: /^Report$/i })).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText(/What is wrong/), 'It flickers all afternoon.');
    expect(within(dialog).getByRole('button', { name: /^Report$/i })).toBeEnabled();
  });

  it('posts the incident and refreshes the list', async () => {
    const fetchMock = api({ 'POST /incidents': { status: 201, body: incident(99, 'Desk light flickering') } });
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    await screen.findByText('Projector will not power on');

    await userEvent.click(screen.getByRole('button', { name: /Report incident/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Desk light flickering');
    await userEvent.type(within(dialog).getByLabelText(/What is wrong/), 'It flickers all afternoon.');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Report$/i }));

    await waitFor(() => {
      const post = reportCall(fetchMock);
      expect(post).toBeDefined();
      expect(JSON.parse(post[1].body)).toMatchObject({
        title: 'Desk light flickering',
        description: 'It flickers all afternoon.',
        category: 'OTHER',
        priority: 'MEDIUM',
      });
    });
    expect(await screen.findByText(/Incident #99 reported/)).toBeInTheDocument();
  });

  it('reports a rejected submission instead of closing silently', async () => {
    api({
      'POST /incidents': {
        status: 400,
        body: { error: { status: 400, type: 'validation_error', message: 'Building 9 does not exist', details: null } },
      },
    });
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    await screen.findByText('Projector will not power on');

    await userEvent.click(screen.getByRole('button', { name: /Report incident/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Something');
    await userEvent.type(within(dialog).getByLabelText(/What is wrong/), 'Details here.');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Report$/i }));

    expect(await screen.findByText('Building 9 does not exist')).toBeInTheDocument();
  });
});

describe('what the list is scoped to', () => {
  it('tells an engineer why rows they are not assigned to are there', async () => {
    api();
    renderPage(<IncidentsPage />, { user: ENGINEER });
    expect(
      await screen.findByText(/yours, plus other faults on equipment you are working on/),
    ).toBeInTheDocument();
  });

  it('tells an employee the list is their own reports', async () => {
    api();
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    expect(await screen.findByText(/the ones you reported/)).toBeInTheDocument();
  });

  it('says nothing to an admin, who sees everything', async () => {
    api();
    renderPage(<IncidentsPage />, { user: ADMIN });
    await screen.findByText('Projector will not power on');
    expect(screen.queryByText(/equipment you are working on/)).not.toBeInTheDocument();
    expect(screen.queryByText(/the ones you reported/)).not.toBeInTheDocument();
  });
});

describe('naming the failed unit while reporting', () => {
  const equipment = [{
    id: 4, code: 'AV-3A-PROJ-01', name: 'Ceiling projector, Meeting Room 3A',
    asset_type: 'PROJECTOR', building_id: 1, building_name: 'HQ North',
    floor_id: 10, floor_level: 3, seat_id: 100, seat_code: '3A-12',
    installed_on: '2020-07-14', expected_life_months: 60,
    service_interval_months: 12, last_serviced_on: '2024-01-10',
    next_service_due: '2025-01-10', service_status: 'overdue', days_until_service: -620,
    retired_on: null, is_retired: false, notes: null,
    incident_count: 4, open_incident_count: 1, last_incident_at: '2026-09-22T10:00:00Z',
    created_at: '2026-09-01T09:00:00Z',
  }];

  it('offers the equipment field even before a location is chosen', async () => {
    api({ 'GET /assets': equipment });
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    await userEvent.click(await screen.findByRole('button', { name: /Report incident/ }));

    const field = await screen.findByLabelText('Equipment');
    expect(field).toBeInTheDocument();
    expect(screen.getByText('Choose a location above to narrow this list')).toBeInTheDocument();
  });

  it('sends the chosen unit with the report', async () => {
    const fetchMock = api({ 'GET /assets': equipment });
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    await userEvent.click(await screen.findByRole('button', { name: /Report incident/ }));

    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Projector is dead again');
    await userEvent.type(within(dialog).getByLabelText(/What is wrong/), 'No power light at all.');
    await userEvent.click(within(dialog).getByLabelText('Equipment'));
    await userEvent.click(await screen.findByRole('option', { name: /AV-3A-PROJ-01/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Report' }));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        ([url, init]) => init?.method === 'POST' && String(url).endsWith('/incidents'),
      );
      expect(posted).toBeTruthy();
      expect(JSON.parse(posted[1].body).asset_id).toBe(4);
    });
  });

  it('says so rather than vanishing when nothing is registered', async () => {
    api({ 'GET /assets': [] });
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    await userEvent.click(await screen.findByRole('button', { name: /Report incident/ }));

    expect(await screen.findByText('No equipment registered at this location yet')).toBeInTheDocument();
  });
});

describe('the equipment filter', () => {
  it('says which unit it is showing, and can be dismissed', async () => {
    api();
    const { store } = renderPage(<IncidentsPage />, { user: ADMIN });
    await screen.findByText('Projector will not power on');

    store.dispatch(setFilters({ asset_id: 4 }));
    expect(await screen.findByText(/Showing failures of/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('CancelIcon'));
    await waitFor(() => expect(store.getState().incidents.filters.asset_id).toBe(''));
  });
});

describe('duplicate detection while reporting', () => {
  const match = (overrides = {}) => ({
    id: 42,
    title: 'Projector will not power on in Meeting Room 3A',
    category: 'AV_EQUIPMENT',
    priority: 'HIGH',
    status: 'OPEN',
    location: { building_id: 1, building_name: 'HQ North', floor_id: 10, floor_level: 3, seat_id: null, seat_code: null },
    created_at: '2026-09-21T09:12:00Z',
    score: 0.76,
    reasons: ['wording is very similar', 'same category'],
    visible: true,
    ...overrides,
  });

  /**
   * Open the report dialog with the list already loaded.
   *
   * @returns {Promise<HTMLElement>} The dialog element.
   */
  const openDialog = async () => {
    await screen.findByText('Projector will not power on');
    await userEvent.click(screen.getByRole('button', { name: /Report incident/i }));
    return screen.findByRole('dialog');
  };

  /**
   * Collect the bodies of every duplicate-check request made so far.
   *
   * @param {import('vitest').Mock} fetchMock The fetch stub.
   * @returns {Array<object>} The parsed request bodies, in order.
   */
  const lookups = (fetchMock) => fetchMock.mock.calls
    .filter(([url, init]) => init?.method === 'POST' && String(url).endsWith('/duplicate-check'))
    .map(([, init]) => JSON.parse(init.body));

  it('warns about a possible duplicate as the reporter types', async () => {
    api({ 'POST /incidents/duplicate-check': { matches: [match()] } });
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    const dialog = await openDialog();

    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Projector dead in 3A');

    expect(await screen.findByTestId('similar-incidents')).toBeInTheDocument();
    expect(screen.getByText(/This may already be reported/)).toBeInTheDocument();
    expect(screen.getByText(/#42 Projector will not power on/)).toBeInTheDocument();
  });

  it('sends the category and location along with the text', async () => {
    const fetchMock = api({ 'POST /incidents/duplicate-check': { matches: [match()] } });
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    const dialog = await openDialog();

    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Projector dead in 3A');
    await screen.findByTestId('similar-incidents');

    await waitFor(() => expect(lookups(fetchMock).length).toBeGreaterThan(0));
    // Category carries a large share of the score, so omitting it would make
    // the suggestions markedly worse without anything failing.
    expect(lookups(fetchMock).at(-1)).toMatchObject({
      title: 'Projector dead in 3A',
      category: 'OTHER',
    });
  });

  it('says nothing until the title is long enough to mean something', async () => {
    const fetchMock = api({ 'POST /incidents/duplicate-check': { matches: [match()] } });
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    const dialog = await openDialog();

    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Proj');
    // Long enough for the debounce to have fired had the guard not stopped it.
    await new Promise((resolve) => { setTimeout(resolve, 700); });

    expect(lookups(fetchMock)).toHaveLength(0);
    expect(screen.queryByTestId('similar-incidents')).not.toBeInTheDocument();
  });

  it('does not block the report when a duplicate is suggested', async () => {
    const fetchMock = api({
      'POST /incidents/duplicate-check': { matches: [match()] },
      'POST /incidents': { status: 201, body: incident(99, 'Projector dead in 3A') },
    });
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    const dialog = await openDialog();

    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Projector dead in 3A');
    await userEvent.type(within(dialog).getByLabelText(/What is wrong/), 'It will not switch on.');
    await screen.findByTestId('similar-incidents');

    expect(within(dialog).getByRole('button', { name: /^Report$/i })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Report$/i }));

    await waitFor(() => expect(reportCall(fetchMock)).toBeDefined());
    expect(await screen.findByText(/Incident #99 reported/)).toBeInTheDocument();
  });

  it('forgets the suggestions once the dialog is closed', async () => {
    api({ 'POST /incidents/duplicate-check': { matches: [match()] } });
    const { store } = renderPage(<IncidentsPage />, { user: EMPLOYEE });
    const dialog = await openDialog();

    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Projector dead in 3A');
    await screen.findByTestId('similar-incidents');

    await userEvent.click(within(dialog).getByRole('button', { name: /Cancel/i }));

    await waitFor(() => expect(store.getState().incidents.duplicates).toEqual([]));
    expect(screen.queryByTestId('similar-incidents')).not.toBeInTheDocument();
  });

  it('keeps the report usable when the duplicate lookup fails', async () => {
    // A lookup is a convenience. If it breaks, the reporter should never know.
    const fetchMock = api({
      'POST /incidents/duplicate-check': {
        status: 503,
        body: { error: { status: 503, type: 'database_unavailable', message: 'nope', details: null } },
      },
      'POST /incidents': { status: 201, body: incident(99, 'Projector dead in 3A') },
    });
    renderPage(<IncidentsPage />, { user: EMPLOYEE });
    const dialog = await openDialog();

    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Projector dead in 3A');
    await userEvent.type(within(dialog).getByLabelText(/What is wrong/), 'It will not switch on.');
    await waitFor(() => expect(lookups(fetchMock).length).toBeGreaterThan(0));

    expect(screen.queryByTestId('similar-incidents')).not.toBeInTheDocument();
    expect(screen.queryByText(/nope/)).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: /^Report$/i }));
    expect(await screen.findByText(/Incident #99 reported/)).toBeInTheDocument();
  });
});

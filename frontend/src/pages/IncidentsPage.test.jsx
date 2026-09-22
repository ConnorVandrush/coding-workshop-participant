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
import { EMPLOYEE, mockApi, renderPage } from '../test/utils';

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
  ...overrides,
});

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
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
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

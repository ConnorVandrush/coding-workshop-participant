/**
 * Tests for the engineers page.
 *
 * The roster is readable by everyone so incidents can be routed sensibly, but
 * only facility admins can change it. Creating a profile promotes an existing
 * account rather than collecting a password, so the form must offer only
 * accounts that do not already have one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EngineersPage from './EngineersPage';
import { ADMIN, EMPLOYEE, mockApi, renderPage } from '../test/utils';

const engineer = (overrides = {}) => ({
  id: 5,
  user_id: 3,
  email: 'sam.okafor@acme.inc',
  full_name: 'Sam Okafor',
  specialties: ['AV_EQUIPMENT', 'HARDWARE'],
  phone: '+1-555-0101',
  is_available: true,
  max_active_incidents: 8,
  active_incidents: 4,
  has_capacity: true,
  created_at: '2026-09-01T09:00:00Z',
  ...overrides,
});

const users = [
  { id: 3, email: 'sam.okafor@acme.inc', full_name: 'Sam Okafor', role: 'engineer', is_active: true, created_at: '2026-09-01T09:00:00Z' },
  { id: 4, email: 'nora.feld@acme.inc', full_name: 'Nora Feld', role: 'employee', is_active: true, created_at: '2026-09-01T09:00:00Z' },
];

/**
 * Stub the engineer endpoints.
 *
 * @param {object} [overrides] Extra or replacement handlers.
 * @returns {import('vitest').Mock} The fetch stub.
 */
const api = (overrides = {}) => mockApi({
  'GET /engineers': [engineer()],
  'GET /users': users,
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('roster', () => {
  it('shows each engineer with their live workload', async () => {
    api();
    renderPage(<EngineersPage />);
    expect(await screen.findByText('Sam Okafor')).toBeInTheDocument();
    expect(screen.getByText(/of 8 active/)).toBeInTheDocument();
    expect(screen.getByText('Has capacity')).toBeInTheDocument();
  });

  it('humanises the specialties', async () => {
    api();
    renderPage(<EngineersPage />);
    expect(await screen.findByText('Av Equipment')).toBeInTheDocument();
    expect(screen.getByText('Hardware')).toBeInTheDocument();
  });

  it('flags an engineer who is at capacity', async () => {
    api({ 'GET /engineers': [engineer({ active_incidents: 8, has_capacity: false })] });
    renderPage(<EngineersPage />);
    expect(await screen.findByText('At capacity')).toBeInTheDocument();
  });

  it('says when nobody has a profile yet', async () => {
    api({ 'GET /engineers': [] });
    renderPage(<EngineersPage />);
    expect(await screen.findByText('No engineer profiles yet.')).toBeInTheDocument();
  });

  it('notes an engineer with no specialties rather than showing nothing', async () => {
    api({ 'GET /engineers': [engineer({ specialties: [] })] });
    renderPage(<EngineersPage />);
    expect(await screen.findByText('No specialties recorded')).toBeInTheDocument();
  });
});

describe('permissions', () => {
  it('gives a facility admin the add button and the availability switch', async () => {
    api();
    renderPage(<EngineersPage />, { user: ADMIN });
    expect(await screen.findByRole('button', { name: /Add engineer/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Available')).toBeInTheDocument();
  });

  it('shows an employee a read-only view', async () => {
    api();
    renderPage(<EngineersPage />, { user: EMPLOYEE });
    await screen.findByText('Sam Okafor');
    expect(screen.queryByRole('button', { name: /Add engineer/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Available')).not.toBeInTheDocument();
    // The state is still visible, just not editable.
    expect(screen.getByText('Available')).toBeInTheDocument();
  });
});

describe('creating a profile', () => {
  it('offers only accounts that do not already have one', async () => {
    api();
    renderPage(<EngineersPage />, { user: ADMIN });
    await userEvent.click(await screen.findByRole('button', { name: /Add engineer/i }));

    await userEvent.click(within(await screen.findByRole('dialog')).getByLabelText('Account'));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options.some((o) => o.includes('Nora Feld'))).toBe(true);
    expect(options.some((o) => o.includes('Sam Okafor'))).toBe(false);
  });

  it('cannot be submitted without choosing an account', async () => {
    api();
    renderPage(<EngineersPage />, { user: ADMIN });
    await userEvent.click(await screen.findByRole('button', { name: /Add engineer/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Create profile/i })).toBeDisabled();
  });

  it('posts the chosen account and capacity', async () => {
    const fetchMock = api({ 'POST /engineers': { status: 201, body: engineer({ id: 6, user_id: 4, full_name: 'Nora Feld' }) } });
    renderPage(<EngineersPage />, { user: ADMIN });
    await userEvent.click(await screen.findByRole('button', { name: /Add engineer/i }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Account'));
    await userEvent.click(await screen.findByRole('option', { name: /Nora Feld/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /Create profile/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(post[1].body)).toMatchObject({ user_id: 4, max_active_incidents: 8 });
    });
    expect(await screen.findByText('Engineer profile created')).toBeInTheDocument();
  });
});

describe('availability', () => {
  it('sends the new availability when toggled', async () => {
    const fetchMock = api({ 'PUT /engineers/:id': engineer({ is_available: false }) });
    renderPage(<EngineersPage />, { user: ADMIN });
    await screen.findByText('Sam Okafor');

    await userEvent.click(screen.getByLabelText('Available'));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(put[1].body)).toEqual({ is_available: false });
    });
    expect(await screen.findByText(/marked unavailable/)).toBeInTheDocument();
  });
});

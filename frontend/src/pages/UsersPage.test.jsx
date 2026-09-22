/**
 * Tests for the accounts page.
 *
 * The rules that protect a deployment - not demoting the last admin, not
 * deactivating yourself - live in the API deliberately, so the page must
 * surface those refusals rather than pre-empting them. It also switches
 * between a table and cards, like the incident list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMediaQuery } from 'react-responsive';
import UsersPage from './UsersPage';
import { ADMIN, mockApi, renderPage } from '../test/utils';

vi.mock('react-responsive', () => ({ useMediaQuery: vi.fn() }));

const users = [
  { id: 1, email: 'admin@acme.inc', full_name: 'Ada Admin', role: 'facility_admin', is_active: true, created_at: '2026-09-01T09:00:00Z' },
  { id: 2, email: 'dana.ruiz@acme.inc', full_name: 'Dana Ruiz', role: 'employee', is_active: true, created_at: '2026-09-02T09:00:00Z' },
  { id: 3, email: 'sam.okafor@acme.inc', full_name: 'Sam Okafor', role: 'engineer', is_active: false, created_at: '2026-09-03T09:00:00Z' },
];

/**
 * Stub the accounts endpoints.
 *
 * @param {object} [overrides] Extra or replacement handlers.
 * @returns {import('vitest').Mock} The fetch stub.
 */
const api = (overrides = {}) => mockApi({ 'GET /users': users, ...overrides });

beforeEach(() => useMediaQuery.mockReturnValue(true));
afterEach(() => vi.unstubAllGlobals());

describe('desktop table', () => {
  it('lists every account with its role', async () => {
    api();
    renderPage(<UsersPage />);
    expect(await screen.findByText('Ada Admin')).toBeInTheDocument();
    expect(screen.getByText('Dana Ruiz')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('marks which row is the signed-in user', async () => {
    api();
    renderPage(<UsersPage />, { user: ADMIN });
    expect(await screen.findByText('You')).toBeInTheDocument();
  });

  it('filters by name or email as you type', async () => {
    api();
    renderPage(<UsersPage />);
    await screen.findByText('Ada Admin');

    await userEvent.type(screen.getByLabelText(/Search by name or email/), 'dana');

    await waitFor(() => expect(screen.queryByText('Ada Admin')).not.toBeInTheDocument());
    expect(screen.getByText('Dana Ruiz')).toBeInTheDocument();
  });
});

describe('phone layout', () => {
  it('drops the table in favour of cards', async () => {
    useMediaQuery.mockReturnValue(false);
    api();
    renderPage(<UsersPage />);
    await screen.findByText('Ada Admin');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('dana.ruiz@acme.inc')).toBeInTheDocument();
  });
});

describe('changing a role', () => {
  it('patches the account and confirms', async () => {
    const fetchMock = api({
      'PATCH /users/:id/role': { ...users[1], role: 'engineer' },
    });
    renderPage(<UsersPage />);
    await screen.findByText('Dana Ruiz');

    const selects = screen.getAllByRole('combobox');
    await userEvent.click(selects[1]);
    await userEvent.click(await screen.findByRole('option', { name: 'Engineer' }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(patch[1].body)).toEqual({ role: 'engineer' });
    });
    expect(await screen.findByText(/Dana Ruiz is now Engineer/)).toBeInTheDocument();
  });

  it('surfaces the API refusing to demote the last admin', async () => {
    // This rule lives in the API so it holds for every client; the page must
    // report it rather than trying to guess it.
    api({
      'PATCH /users/:id/role': {
        status: 403,
        body: { error: { status: 403, type: 'last_admin', message: 'At least one active facility admin must remain', details: null } },
      },
    });
    renderPage(<UsersPage />);
    await screen.findByText('Ada Admin');

    const selects = screen.getAllByRole('combobox');
    await userEvent.click(selects[0]);
    await userEvent.click(await screen.findByRole('option', { name: 'Employee' }));

    expect(await screen.findByText('At least one active facility admin must remain')).toBeInTheDocument();
  });
});

describe('activation', () => {
  it('reflects the stored activation state', async () => {
    api();
    renderPage(<UsersPage />);
    await screen.findByText('Sam Okafor');
    expect(screen.getByLabelText('Active state for Sam Okafor')).not.toBeChecked();
    expect(screen.getByLabelText('Active state for Dana Ruiz')).toBeChecked();
  });

  it('patches the activation state when toggled', async () => {
    const fetchMock = api({ 'PATCH /users/:id/status': { ...users[1], is_active: false } });
    renderPage(<UsersPage />);
    await screen.findByText('Dana Ruiz');

    await userEvent.click(screen.getByLabelText('Active state for Dana Ruiz'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(patch[1].body)).toEqual({ is_active: false });
    });
    expect(await screen.findByText(/Dana Ruiz deactivated/)).toBeInTheDocument();
  });

  it('surfaces the API refusing self-deactivation', async () => {
    api({
      'PATCH /users/:id/status': {
        status: 403,
        body: { error: { status: 403, type: 'self_deactivation', message: 'You cannot deactivate your own account', details: null } },
      },
    });
    renderPage(<UsersPage />, { user: ADMIN });
    await screen.findByText('Ada Admin');

    await userEvent.click(screen.getByLabelText('Active state for Ada Admin'));

    expect(await screen.findByText('You cannot deactivate your own account')).toBeInTheDocument();
  });
});

/**
 * Tests for the facilities page.
 *
 * Everyone can browse the hierarchy because employees need it to place an
 * incident; only facility admins get the create and delete controls. The
 * floors and seats load lazily, which is the other behaviour worth pinning.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FacilitiesPage from './FacilitiesPage';
import { ADMIN, EMPLOYEE, mockApi, renderPage } from '../test/utils';

const buildings = [
  { id: 1, name: 'HQ North', address: '1 Market St', floor_count: 2, created_at: '2026-09-01T09:00:00Z' },
  { id: 2, name: 'Riverside Annex', address: '88 Hudson Pkwy', floor_count: 1, created_at: '2026-09-01T09:00:00Z' },
];

const floors = [
  { id: 10, building_id: 1, building_name: 'HQ North', level: 1, name: 'Reception', seat_count: 3, created_at: '2026-09-01T09:00:00Z' },
  { id: 11, building_id: 1, building_name: 'HQ North', level: 3, name: 'Engineering', seat_count: 4, created_at: '2026-09-01T09:00:00Z' },
];

const seats = [
  { id: 100, floor_id: 11, building_id: 1, building_name: 'HQ North', floor_level: 3, code: '3A-12', description: 'Window desk', created_at: '2026-09-01T09:00:00Z' },
];

/**
 * Stub the facility endpoints.
 *
 * @param {object} [overrides] Extra or replacement handlers.
 * @returns {import('vitest').Mock} The fetch stub.
 */
const api = (overrides = {}) => mockApi({
  'GET /buildings': buildings,
  'GET /buildings/:id/floors': floors,
  'GET /floors/:id/seats': seats,
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('browsing', () => {
  it('lists buildings with their floor counts', async () => {
    api();
    renderPage(<FacilitiesPage />);
    expect(await screen.findByText('HQ North')).toBeInTheDocument();
    expect(screen.getByText(/2 floors · 1 Market St/)).toBeInTheDocument();
  });

  it('prompts for a selection before showing floors', async () => {
    api();
    renderPage(<FacilitiesPage />);
    expect(await screen.findByText('Select a building to see its floors and seats.')).toBeInTheDocument();
  });

  it('loads the floors of the selected building', async () => {
    api();
    renderPage(<FacilitiesPage />);
    await userEvent.click(await screen.findByText('HQ North'));
    expect(await screen.findByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Level 3')).toBeInTheDocument();
  });

  it('loads seats only when a floor is expanded', async () => {
    const fetchMock = api();
    renderPage(<FacilitiesPage />);
    await userEvent.click(await screen.findByText('HQ North'));
    await screen.findByText('Engineering');

    // Lazily: nothing should have asked for seats yet.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/seats'))).toBe(false);

    await userEvent.click(screen.getByText('Engineering'));
    expect(await screen.findByText('3A-12')).toBeInTheDocument();
  });
});

describe('permissions', () => {
  it('gives a facility admin the create controls', async () => {
    api();
    renderPage(<FacilitiesPage />, { user: ADMIN });
    expect(await screen.findByText('Add a building')).toBeInTheDocument();
  });

  it('withholds them from an employee', async () => {
    api();
    renderPage(<FacilitiesPage />, { user: EMPLOYEE });
    await screen.findByText('HQ North');
    expect(screen.queryByText('Add a building')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Delete HQ North/)).not.toBeInTheDocument();
  });

  it('still lets an employee browse the hierarchy', async () => {
    api();
    renderPage(<FacilitiesPage />, { user: EMPLOYEE });
    await userEvent.click(await screen.findByText('HQ North'));
    expect(await screen.findByText('Engineering')).toBeInTheDocument();
  });
});

describe('creating', () => {
  it('keeps the add button disabled until a name is typed', async () => {
    api();
    renderPage(<FacilitiesPage />, { user: ADMIN });
    await screen.findByText('Add a building');

    const add = screen.getByRole('button', { name: /^Add$/i });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Name'), 'Tech Pavilion');
    expect(add).toBeEnabled();
  });

  it('posts the new building', async () => {
    const created = { id: 3, name: 'Tech Pavilion', address: null, floor_count: 0, created_at: '2026-09-22T12:00:00Z' };
    const fetchMock = api({ 'POST /buildings': { status: 201, body: created } });
    renderPage(<FacilitiesPage />, { user: ADMIN });
    await screen.findByText('Add a building');

    await userEvent.type(screen.getByLabelText('Name'), 'Tech Pavilion');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(post[1].body)).toEqual({ name: 'Tech Pavilion', address: null });
    });
    expect(await screen.findByText('Building created')).toBeInTheDocument();
  });

  it('surfaces a duplicate name rejection', async () => {
    api({
      'POST /buildings': {
        status: 409,
        body: { error: { status: 409, type: 'conflict', message: 'A building with that name already exists', details: null } },
      },
    });
    renderPage(<FacilitiesPage />, { user: ADMIN });
    await screen.findByText('Add a building');

    await userEvent.type(screen.getByLabelText('Name'), 'HQ North');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    expect(await screen.findByText('A building with that name already exists')).toBeInTheDocument();
  });
});

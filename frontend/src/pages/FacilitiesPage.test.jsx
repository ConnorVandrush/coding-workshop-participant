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
    await userEvent.type(screen.getByLabelText(/^Name/), 'Tech Pavilion');
    expect(add).toBeEnabled();
  });

  it('posts the new building', async () => {
    const created = { id: 3, name: 'Tech Pavilion', address: null, floor_count: 0, created_at: '2026-09-22T12:00:00Z' };
    const fetchMock = api({ 'POST /buildings': { status: 201, body: created } });
    renderPage(<FacilitiesPage />, { user: ADMIN });
    await screen.findByText('Add a building');

    await userEvent.type(screen.getByLabelText(/^Name/), 'Tech Pavilion');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(post[1].body)).toEqual({ name: 'Tech Pavilion', address: null });
    });
    expect(await screen.findByText('Building created')).toBeInTheDocument();
  });

  it('shows a field-level validation message beside the input it refers to', async () => {
    // The API reports failures per field; showing them only in a toast leaves
    // the user hunting for which input was wrong.
    api({
      'POST /buildings': {
        status: 400,
        body: {
          error: {
            status: 400,
            type: 'validation_error',
            message: 'Request payload failed validation',
            details: [{ field: 'body.name', message: 'name must be at least 1 character' }],
          },
        },
      },
    });
    renderPage(<FacilitiesPage />, { user: ADMIN });
    await screen.findByText('Add a building');

    await userEvent.type(screen.getByLabelText(/^Name/), 'x');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    const nameField = await screen.findByLabelText(/^Name/);
    expect(await screen.findByText('name must be at least 1 character')).toBeInTheDocument();
    expect(nameField).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears the field error once the input is edited again', async () => {
    api({
      'POST /buildings': {
        status: 400,
        body: {
          error: {
            status: 400,
            type: 'validation_error',
            message: 'Request payload failed validation',
            details: [{ field: 'body.name', message: 'name is not acceptable' }],
          },
        },
      },
    });
    renderPage(<FacilitiesPage />, { user: ADMIN });
    await screen.findByText('Add a building');

    await userEvent.type(screen.getByLabelText(/^Name/), 'x');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    expect(await screen.findByText('name is not acceptable')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^Name/), 'y');
    expect(screen.queryByText('name is not acceptable')).not.toBeInTheDocument();
  });

  it('marks the required fields so they are visually distinguishable', async () => {
    api();
    renderPage(<FacilitiesPage />, { user: ADMIN });
    await screen.findByText('Add a building');
    expect(screen.getByLabelText(/^Name/)).toBeRequired();
    expect(screen.getByLabelText(/^Address/)).not.toBeRequired();
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

    await userEvent.type(screen.getByLabelText(/^Name/), 'HQ North');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    expect(await screen.findByText('A building with that name already exists')).toBeInTheDocument();
  });
});

describe('adding floors and seats', () => {
  it('posts a new floor to the selected building', async () => {
    const created = { id: 12, building_id: 1, building_name: 'HQ North', level: 5, name: 'Lab', seat_count: 0, created_at: '2026-09-22T09:00:00Z' };
    const fetchMock = api({ 'POST /buildings/:id/floors': { status: 201, body: created } });
    renderPage(<FacilitiesPage />);
    await userEvent.click(await screen.findByText('HQ North'));
    await screen.findByText('Engineering');

    await userEvent.type(screen.getByLabelText(/Level/), '5');
    await userEvent.type(screen.getByLabelText(/Floor name/), 'Lab');
    await userEvent.click(screen.getByRole('button', { name: /Add floor/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => init?.method === 'POST' && String(url).includes('/buildings/1/floors'),
      );
      expect(post).toBeDefined();
      // `level` is typed into a text field but the API takes a number.
      expect(JSON.parse(post[1].body)).toEqual({ level: 5, name: 'Lab' });
    });
    expect(await screen.findByText(/Floor added/)).toBeInTheDocument();
  });

  it('sends a null name when the optional floor name is left blank', async () => {
    // The API rejects "" for an optional string, so the page must send null.
    const fetchMock = api({
      'POST /buildings/:id/floors': { status: 201, body: { id: 13, building_id: 1, level: 6, name: null, seat_count: 0, created_at: '2026-09-22T09:00:00Z' } },
    });
    renderPage(<FacilitiesPage />);
    await userEvent.click(await screen.findByText('HQ North'));
    await screen.findByText('Engineering');

    await userEvent.type(screen.getByLabelText(/Level/), '6');
    await userEvent.click(screen.getByRole('button', { name: /Add floor/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => init?.method === 'POST' && String(url).includes('/floors'),
      );
      expect(JSON.parse(post[1].body)).toEqual({ level: 6, name: null });
    });
  });

  // One floor, so each per-floor control appears exactly once and can be
  // addressed by role and name rather than by position in a list.
  const oneFloor = { 'GET /buildings/:id/floors': [floors[1]] };

  it('posts a new seat to the floor it was typed under', async () => {
    const fetchMock = api({
      ...oneFloor,
      'POST /floors/:id/seats': { status: 201, body: { id: 101, floor_id: 11, code: '3A-13', created_at: '2026-09-22T09:00:00Z' } },
    });
    renderPage(<FacilitiesPage />);
    await userEvent.click(await screen.findByText('HQ North'));
    await userEvent.click(await screen.findByText('Engineering'));
    await screen.findByText('3A-12');

    await userEvent.type(screen.getByLabelText(/Seat code/), '3A-13');
    await userEvent.click(screen.getByRole('button', { name: /Add seat/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => init?.method === 'POST' && String(url).includes('/floors/11/seats'),
      );
      expect(post).toBeDefined();
      expect(JSON.parse(post[1].body)).toEqual({ code: '3A-13' });
    });
  });

  it('does nothing when the seat code is only whitespace', async () => {
    // Guards the early return: without it the API is asked to create a seat
    // with an empty code and answers 400, for a mistake the page can see.
    const fetchMock = api(oneFloor);
    renderPage(<FacilitiesPage />);
    await userEvent.click(await screen.findByText('HQ North'));
    await userEvent.click(await screen.findByText('Engineering'));
    await screen.findByText('3A-12');

    await userEvent.type(screen.getByLabelText(/Seat code/), '   ');
    await userEvent.click(screen.getByRole('button', { name: /Add seat/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });
  });
});

describe('deleting', () => {
  const oneFloor = { 'GET /buildings/:id/floors': [floors[1]] };

  it('deletes a building once the warning is accepted', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetchMock = api({ 'DELETE /buildings/:id': { status: 204, body: undefined } });
    renderPage(<FacilitiesPage />);
    await screen.findByText('HQ North');

    await userEvent.click(screen.getByRole('button', { name: 'Delete HQ North' }));

    // The prompt has to say that nested records go too - a building is not an
    // isolated row, and the API cascades to its floors and seats.
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/nested under it is removed too/));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([url, init]) => init?.method === 'DELETE' && String(url).endsWith('/buildings/1'),
      )).toBe(true);
    });
  });

  it('deletes nothing when the warning is dismissed', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const fetchMock = api({ 'DELETE /buildings/:id': { status: 204, body: undefined } });
    renderPage(<FacilitiesPage />);
    await screen.findByText('HQ North');

    await userEvent.click(screen.getByRole('button', { name: 'Delete HQ North' }));

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });
  });

  it('deletes a floor', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetchMock = api({ ...oneFloor, 'DELETE /floors/:id': { status: 204, body: undefined } });
    renderPage(<FacilitiesPage />);
    await userEvent.click(await screen.findByText('HQ North'));
    // The control lives inside the accordion body, so the floor has to be
    // expanded before it exists.
    await userEvent.click(await screen.findByText('Engineering'));

    await userEvent.click(await screen.findByRole('button', { name: /Delete floor/i }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/level 3/));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([url, init]) => init?.method === 'DELETE' && String(url).endsWith('/floors/11'),
      )).toBe(true);
    });
  });

  it('deletes a seat', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetchMock = api({ ...oneFloor, 'DELETE /seats/:id': { status: 204, body: undefined } });
    renderPage(<FacilitiesPage />);
    await userEvent.click(await screen.findByText('HQ North'));
    await userEvent.click(await screen.findByText('Engineering'));
    await screen.findByText('3A-12');

    // A seat is a MUI Chip, so its remove control is the chip's delete icon.
    await userEvent.click(screen.getByTestId('CancelIcon'));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/seat 3A-12/));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([url, init]) => init?.method === 'DELETE' && String(url).endsWith('/seats/100'),
      )).toBe(true);
    });
  });

  it('reports a rejected delete instead of failing silently', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    api({
      'DELETE /buildings/:id': {
        status: 409,
        body: { error: { status: 409, type: 'conflict', message: 'Building still has open incidents', details: null } },
      },
    });
    renderPage(<FacilitiesPage />);
    await screen.findByText('HQ North');

    await userEvent.click(screen.getByRole('button', { name: 'Delete HQ North' }));
    expect(await screen.findByText('Building still has open incidents')).toBeInTheDocument();
  });
});

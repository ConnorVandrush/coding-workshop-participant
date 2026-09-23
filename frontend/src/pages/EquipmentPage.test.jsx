/**
 * Tests for the equipment register.
 *
 * The page is the write surface for the estate's equipment, so what matters is
 * that it shows a unit's upkeep honestly, that the controls which change the
 * register appear only for the persona the API lets change it, and that
 * editing sends the unit's existing values rather than a blank form.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EquipmentPage from './EquipmentPage';
import { ADMIN, ENGINEER, mockApi, renderPage } from '../test/utils';

const buildings = [
  { id: 1, name: 'HQ North', address: '1 Market St', floor_count: 2, created_at: '2026-09-01T09:00:00Z' },
];

const asset = (overrides = {}) => ({
  id: 4, code: 'AV-3A-PROJ-01', name: 'Ceiling projector, Meeting Room 3A',
  asset_type: 'PROJECTOR', manufacturer: 'Epson', model: 'EB-L200',
  building_id: 1, building_name: 'HQ North', floor_id: 3, floor_level: 3,
  seat_id: 7, seat_code: '3A-12', installed_on: '2020-07-14',
  expected_life_months: 60, service_interval_months: 12,
  last_serviced_on: '2024-01-10', next_service_due: '2025-01-10',
  service_status: 'overdue', days_until_service: -620,
  retired_on: null, is_retired: false, notes: null,
  incident_count: 4, open_incident_count: 1, last_incident_at: '2026-09-22T10:00:00Z',
  created_at: '2026-09-01T09:00:00Z',
  ...overrides,
});

/**
 * Stub the endpoints the page loads.
 *
 * @param {object} [overrides] Extra or replacement handlers.
 * @returns {import('vitest').Mock} The fetch stub.
 */
const api = (overrides = {}) => mockApi({
  'GET /buildings': buildings,
  'GET /assets': [asset()],
  'GET /buildings/:id/floors': [],
  ...overrides,
});

const render = (user = ADMIN) => renderPage(<EquipmentPage />, { user, route: '/equipment' });

afterEach(() => vi.unstubAllGlobals());

describe('browsing the register', () => {
  it('lists each unit with its place and its upkeep', async () => {
    api();
    render();
    const table = await screen.findByRole('table', { name: 'Equipment register' });
    expect(within(table).getByText('AV-3A-PROJ-01')).toBeInTheDocument();
    expect(within(table).getByText('HQ North · Level 3 · 3A-12')).toBeInTheDocument();
    // The class reads as part of what the unit is, rather than its own column.
    expect(within(table).getByText(/Projector · Ceiling projector/)).toBeInTheDocument();
    expect(within(table).getByText('Overdue by 620 days')).toBeInTheDocument();
  });

  it('says so plainly when nothing matches', async () => {
    api({ 'GET /assets': [] });
    render();
    expect(await screen.findByText(/No equipment matches/)).toBeInTheDocument();
  });

  it('narrows the register to one building', async () => {
    const fetchMock = api();
    render();
    await screen.findByRole('table', { name: 'Equipment register' });

    await userEvent.click(screen.getByText('HQ North'));
    await waitFor(() => {
      const called = fetchMock.mock.calls.map(([url]) => String(url));
      expect(called.some((url) => url.includes('/assets?building_id=1'))).toBe(true);
    });
  });

  it('marks a retired unit rather than hiding what it was', async () => {
    api({ 'GET /assets': [asset({ is_retired: true, retired_on: '2026-01-05' })] });
    render();
    const table = await screen.findByRole('table', { name: 'Equipment register' });
    expect(within(table).getByText('Retired')).toBeInTheDocument();
  });
});

describe('controls mirror the API permissions', () => {
  it('gives a facility admin the full set', async () => {
    api();
    render(ADMIN);
    expect(await screen.findByRole('button', { name: 'Register equipment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record a service for AV-3A-PROJ-01' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retire AV-3A-PROJ-01' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit AV-3A-PROJ-01' })).toBeInTheDocument();
  });

  it('gives an engineer the register to read and nothing to change', async () => {
    api();
    render(ENGINEER);
    await screen.findByRole('table', { name: 'Equipment register' });
    expect(screen.queryByRole('button', { name: 'Register equipment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retire AV-3A-PROJ-01' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit AV-3A-PROJ-01' })).not.toBeInTheDocument();
  });

  it('will not offer a service to a unit with no interval to restart', async () => {
    api({ 'GET /assets': [asset({ service_interval_months: null, service_status: 'unknown', days_until_service: null })] });
    render(ADMIN);
    expect(await screen.findByRole('button', { name: 'Record a service for AV-3A-PROJ-01' })).toBeDisabled();
  });
});

describe('writing to the register', () => {
  it('registers a new unit', async () => {
    const fetchMock = api({ 'POST /assets': { status: 201, body: asset() } });
    render(ADMIN);
    await userEvent.click(await screen.findByRole('button', { name: 'Register equipment' }));

    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Asset tag/), 'HVAC-2-AHU-04');
    await userEvent.type(within(dialog).getByLabelText(/^Class/), 'air handling unit');
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Air handling unit');
    await userEvent.type(within(dialog).getByLabelText(/Service every/), '6');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(posted).toBeTruthy();
      const body = JSON.parse(posted[1].body);
      expect(body.asset_type).toBe('AIR_HANDLING_UNIT');
      expect(body.service_interval_months).toBe(6);
    });
  });

  it('opens an edit with the unit already in the form, and sends a PUT', async () => {
    const fetchMock = api({ 'PUT /assets/:id': asset({ name: 'Ceiling projector, Room 3A' }) });
    render(ADMIN);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit AV-3A-PROJ-01' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(/Asset tag/)).toHaveValue('AV-3A-PROJ-01');
    expect(within(dialog).getByLabelText(/Service every/)).toHaveValue(12);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put[1].body).code).toBe('AV-3A-PROJ-01');
    });
  });

  it('records a service against a unit', async () => {
    const fetchMock = api({ 'POST /assets/:id/service': asset({ service_status: 'ok', days_until_service: 365 }) });
    render(ADMIN);
    await userEvent.click(await screen.findByRole('button', { name: 'Record a service for AV-3A-PROJ-01' }));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        ([url, init]) => init?.method === 'POST' && String(url).includes('/service'),
      );
      expect(posted).toBeTruthy();
    });
    expect(await screen.findByText(/marked as serviced/)).toBeInTheDocument();
  });

  it('confirms before removing a unit, and keeps its incidents', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetchMock = api({ 'DELETE /assets/:id': { status: 204, body: undefined } });
    render(ADMIN);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove AV-3A-PROJ-01' }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/incidents are kept/));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => init?.method === 'DELETE' && String(url).endsWith('/assets/4'))).toBe(true);
    });
  });
});

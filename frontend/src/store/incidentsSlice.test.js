/**
 * Tests for the incidents slice.
 *
 * The reducers here encode behaviour that is easy to break and invisible when
 * it does: resetting pagination when a filter changes, and keeping the detail
 * view and the matching list row in step after a write.
 */

import { describe, expect, it } from 'vitest';
import reducer, {
  DEFAULT_FILTERS,
  assignIncident,
  changeStatus,
  clearCurrent,
  deleteIncident,
  escalateIncident,
  fetchIncidents,
  resetFilters,
  setFilters,
  setPage,
  updateIncident,
} from './incidentsSlice';

/**
 * Build a minimal incident.
 *
 * @param {number} id Incident id.
 * @param {object} [overrides] Fields to override.
 * @returns {object} An incident-shaped object.
 */
const incident = (id, overrides = {}) => ({
  id,
  title: `Incident ${id}`,
  status: 'OPEN',
  priority: 'MEDIUM',
  note_count: 0,
  ...overrides,
});

/** @returns {object} A fresh initial state. */
const initial = () => reducer(undefined, { type: '@@INIT' });

describe('filters and pagination', () => {
  it('starts with every filter cleared', () => {
    expect(initial().filters).toEqual(DEFAULT_FILTERS);
    expect(initial().page).toBe(0);
  });

  it('merges a partial filter update rather than replacing the set', () => {
    const state = reducer(initial(), setFilters({ status: 'OPEN' }));
    expect(state.filters.status).toBe('OPEN');
    expect(state.filters.sort).toBe(DEFAULT_FILTERS.sort);
  });

  it('returns to the first page when a filter changes', () => {
    // Otherwise a narrowed result set can leave the user on a page that no
    // longer exists, showing an empty list for a filter that has matches.
    let state = reducer(initial(), setPage(3));
    state = reducer(state, setFilters({ q: 'projector' }));
    expect(state.page).toBe(0);
  });

  it('resetFilters restores the defaults and the first page', () => {
    let state = reducer(initial(), setFilters({ status: 'BLOCKED', q: 'x' }));
    state = reducer(state, setPage(2));
    state = reducer(state, resetFilters());
    expect(state.filters).toEqual(DEFAULT_FILTERS);
    expect(state.page).toBe(0);
  });
});

describe('list loading', () => {
  it('records items and total on success', () => {
    const state = reducer(
      initial(),
      { type: fetchIncidents.fulfilled.type, payload: { items: [incident(1)], total: 24 } },
    );
    expect(state.listStatus).toBe('succeeded');
    expect(state.total).toBe(24);
    expect(state.items).toHaveLength(1);
  });

  it('surfaces a rejection message instead of failing silently', () => {
    const state = reducer(initial(), { type: fetchIncidents.rejected.type, payload: 'boom' });
    expect(state.listStatus).toBe('failed');
    expect(state.listError).toBe('boom');
  });
});

describe('writes keep the detail view and the list row in step', () => {
  const writes = [
    ['updateIncident', updateIncident],
    ['assignIncident', assignIncident],
    ['changeStatus', changeStatus],
    ['escalateIncident', escalateIncident],
  ];

  it.each(writes)('%s refreshes both current and the matching row', (_name, thunk) => {
    const before = { ...initial(), items: [incident(1), incident(2)], current: incident(1) };
    const updated = incident(1, { status: 'RESOLVED' });
    const state = reducer(before, { type: thunk.fulfilled.type, payload: updated });

    expect(state.current.status).toBe('RESOLVED');
    expect(state.items[0].status).toBe('RESOLVED');
    // The untouched row must not be disturbed.
    expect(state.items[1].status).toBe('OPEN');
  });

  it('does not invent a row when the updated incident is not on this page', () => {
    const before = { ...initial(), items: [incident(2)], current: incident(1) };
    const state = reducer(before, { type: changeStatus.fulfilled.type, payload: incident(1, { status: 'CLOSED' }) });
    expect(state.items).toHaveLength(1);
    expect(state.current.status).toBe('CLOSED');
  });

  it('clears the saving flag once a write settles', () => {
    let state = reducer(initial(), { type: changeStatus.pending.type });
    expect(state.saving).toBe(true);
    state = reducer(state, { type: changeStatus.fulfilled.type, payload: incident(1) });
    expect(state.saving).toBe(false);
  });

  it('does not set the saving flag for reads', () => {
    const state = reducer(initial(), { type: fetchIncidents.pending.type });
    expect(state.saving).toBe(false);
  });
});

describe('deletion', () => {
  it('removes the row, decrements the total and clears the detail view', () => {
    const before = { ...initial(), items: [incident(1), incident(2)], total: 2, current: incident(1) };
    const state = reducer(before, { type: deleteIncident.fulfilled.type, payload: 1 });
    expect(state.items.map((i) => i.id)).toEqual([2]);
    expect(state.total).toBe(1);
    expect(state.current).toBeNull();
  });

  it('never drives the total below zero', () => {
    const before = { ...initial(), items: [], total: 0 };
    const state = reducer(before, { type: deleteIncident.fulfilled.type, payload: 99 });
    expect(state.total).toBe(0);
  });
});

describe('clearCurrent', () => {
  it('drops the incident and its notes when leaving the detail view', () => {
    const before = { ...initial(), current: incident(1), notes: [{ id: 1 }], currentStatus: 'succeeded' };
    const state = reducer(before, clearCurrent());
    expect(state.current).toBeNull();
    expect(state.notes).toEqual([]);
    expect(state.currentStatus).toBe('idle');
  });
});

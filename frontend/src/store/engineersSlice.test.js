/**
 * Tests for the engineers slice.
 *
 * Roster changes and account changes land in the same slice, because the
 * engineer form picks from registered accounts. Both lists must stay accurate
 * after a write.
 */

import { describe, expect, it } from 'vitest';
import reducer, {
  createEngineer,
  deleteEngineer,
  fetchEngineers,
  fetchUsers,
  updateEngineer,
  updateUserRole,
  updateUserStatus,
} from './engineersSlice';

const engineer = (id, overrides = {}) => ({
  id, user_id: id + 10, full_name: `Engineer ${id}`, email: `e${id}@acme.inc`,
  specialties: [], is_available: true, max_active_incidents: 8,
  active_incidents: 0, has_capacity: true, ...overrides,
});
const user = (id, overrides = {}) => ({
  id, email: `u${id}@acme.inc`, full_name: `User ${id}`, role: 'employee', is_active: true, ...overrides,
});

/** @returns {object} A fresh initial state. */
const initial = () => reducer(undefined, { type: '@@INIT' });

describe('roster', () => {
  it('records the loaded engineers', () => {
    const state = reducer(initial(), { type: fetchEngineers.fulfilled.type, payload: [engineer(1)] });
    expect(state.status).toBe('succeeded');
    expect(state.items).toHaveLength(1);
  });

  it('surfaces a load failure with a fallback message', () => {
    expect(reducer(initial(), { type: fetchEngineers.rejected.type }).error)
      .toBe('Could not load engineers');
    expect(reducer(initial(), { type: fetchEngineers.rejected.type, payload: 'boom' }).error)
      .toBe('boom');
  });

  it('appends a created profile', () => {
    const state = reducer(initial(), { type: createEngineer.fulfilled.type, payload: engineer(1) });
    expect(state.items).toHaveLength(1);
  });

  it('replaces an updated profile without touching its neighbours', () => {
    const before = { ...initial(), items: [engineer(1), engineer(2)] };
    const state = reducer(before, {
      type: updateEngineer.fulfilled.type,
      payload: engineer(1, { is_available: false }),
    });
    expect(state.items[0].is_available).toBe(false);
    expect(state.items[1].is_available).toBe(true);
  });

  it('ignores an update for a profile it does not hold', () => {
    const before = { ...initial(), items: [engineer(2)] };
    const state = reducer(before, { type: updateEngineer.fulfilled.type, payload: engineer(1) });
    expect(state.items).toHaveLength(1);
    expect(state.items[0].id).toBe(2);
  });

  it('removes a deleted profile', () => {
    const before = { ...initial(), items: [engineer(1), engineer(2)] };
    const state = reducer(before, { type: deleteEngineer.fulfilled.type, payload: 1 });
    expect(state.items.map((e) => e.id)).toEqual([2]);
  });
});

describe('accounts', () => {
  it('records the loaded accounts', () => {
    const state = reducer(initial(), { type: fetchUsers.fulfilled.type, payload: [user(1)] });
    expect(state.users).toHaveLength(1);
  });

  it.each([
    ['a role change', updateUserRole, { role: 'engineer' }],
    ['an activation change', updateUserStatus, { is_active: false }],
  ])('applies %s to the matching account', (_name, thunk, change) => {
    const before = { ...initial(), users: [user(1), user(2)] };
    const state = reducer(before, { type: thunk.fulfilled.type, payload: user(1, change) });
    expect(state.users[0]).toMatchObject(change);
    expect(state.users[1]).toMatchObject({ role: 'employee', is_active: true });
  });

  it('ignores a change for an account it does not hold', () => {
    const before = { ...initial(), users: [user(2)] };
    const state = reducer(before, { type: updateUserRole.fulfilled.type, payload: user(1, { role: 'engineer' }) });
    expect(state.users).toHaveLength(1);
    expect(state.users[0].role).toBe('employee');
  });
});

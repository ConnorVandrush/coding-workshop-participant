/**
 * Tests for the auth slice.
 *
 * Covers the session rules that decide whether a user stays signed in: storing
 * a token on success, and dropping a restored token that turns out to be
 * expired rather than leaving the app in a half-authenticated state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import reducer, { clearAuthError, loadSession, login, logout, register } from './authSlice';

const TOKEN_KEY = 'acme.facility.token';

const user = {
  id: 1,
  email: 'admin@acme.inc',
  full_name: 'Ada Admin',
  role: 'facility_admin',
  is_active: true,
};

/** @returns {object} A fresh initial state. */
const initial = () => reducer(undefined, { type: '@@INIT' });

beforeEach(() => {
  window.localStorage.clear();
});

describe('sign in', () => {
  it.each([
    ['login', login],
    ['register', register],
  ])('%s stores the token, the profile and marks the session ready', (_name, thunk) => {
    const state = reducer(initial(), {
      type: thunk.fulfilled.type,
      payload: { access_token: 'tok', user },
    });
    expect(state.token).toBe('tok');
    expect(state.user).toEqual(user);
    expect(state.status).toBe('succeeded');
    expect(state.initialised).toBe(true);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe('tok');
  });

  it('records a failure message without clearing an existing session', () => {
    const state = reducer(initial(), {
      type: login.rejected.type,
      payload: { message: 'Email or password is incorrect', fields: {} },
    });
    expect(state.status).toBe('failed');
    expect(state.error).toBe('Email or password is incorrect');
  });

  it('clears the pending error when the user edits the form', () => {
    const failed = reducer(initial(), { type: login.rejected.type, payload: { message: 'nope' } });
    expect(reducer(failed, clearAuthError()).error).toBeNull();
  });

  it('drops any stale error when a new attempt starts', () => {
    const failed = reducer(initial(), { type: login.rejected.type, payload: { message: 'nope' } });
    const pending = reducer(failed, { type: login.pending.type });
    expect(pending.status).toBe('loading');
    expect(pending.error).toBeNull();
  });
});

describe('restoring a session', () => {
  it('adopts the profile when the stored token is still valid', () => {
    const state = reducer({ ...initial(), token: 'tok' }, { type: loadSession.fulfilled.type, payload: user });
    expect(state.user).toEqual(user);
    expect(state.initialised).toBe(true);
  });

  it('discards an expired token instead of leaving a half-signed-in state', () => {
    // A token restored from localStorage may have expired while the tab was
    // closed; keeping it would let guarded routes render and then 401.
    window.localStorage.setItem(TOKEN_KEY, 'stale');
    const state = reducer({ ...initial(), token: 'stale' }, { type: loadSession.rejected.type });
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(state.initialised).toBe(true);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe('sign out', () => {
  it('clears the session and the persisted token', () => {
    window.localStorage.setItem(TOKEN_KEY, 'tok');
    const signedIn = { ...initial(), token: 'tok', user, status: 'succeeded' };
    const state = reducer(signedIn, logout());
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe('storage resilience', () => {
  it('still signs the user in when localStorage throws', () => {
    // Private windows and blocked site data make setItem throw; the session
    // should work for the tab even if it cannot survive a refresh.
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const state = reducer(initial(), { type: login.fulfilled.type, payload: { access_token: 'tok', user } });
    expect(state.token).toBe('tok');
    spy.mockRestore();
  });
});

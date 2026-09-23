/**
 * Tests for session renewal.
 *
 * The rules that matter are subtle and easy to break silently: the rotating
 * refresh token must be replaced on every renewal, a burst of expiries must
 * cause exactly one renewal, and a failed renewal must end the session rather
 * than loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import authReducer, { loadSession, login, logout } from './authSlice';
import incidentsReducer, { fetchIncidents } from './incidentsSlice';
import { refreshSession } from './session';

const user = { id: 1, email: 'dana@acme.inc', full_name: 'Dana', role: 'employee', is_active: true };

/**
 * Build a store with a signed-in session.
 *
 * @returns {object} The configured store.
 */
function signedInStore() {
  return configureStore({
    reducer: { auth: authReducer, incidents: incidentsReducer },
    preloadedState: {
      auth: {
        token: 'access-1',
        refreshToken: 'refresh-1',
        user,
        status: 'succeeded',
        error: null,
        initialised: true,
      },
    },
  });
}

/**
 * Stub fetch with a queue of responses keyed by path fragment.
 *
 * @param {Function} handler Receives (url, init) and returns {status, body}.
 * @returns {import('vitest').Mock} The stub.
 */
function stubFetch(handler) {
  const mock = vi.fn(async (url, init) => {
    const { status, body } = handler(String(url), init ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body ?? null),
    };
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const expired = {
  status: 401,
  body: { error: { status: 401, type: 'token_expired', message: 'Access token has expired', details: null } },
};
const renewed = {
  status: 200,
  body: { access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'bearer', expires_in: 1800, user },
};
const page = { status: 200, body: { items: [], total: 0, limit: 25, offset: 0 } };

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('rotation', () => {
  it('stores the replacement refresh token, not just the access token', async () => {
    // Each refresh token is valid once. Keeping the old one would make the
    // next renewal look like a replay and end the session.
    stubFetch(() => renewed);
    const store = signedInStore();

    await store.dispatch(refreshSession());

    expect(store.getState().auth.token).toBe('access-2');
    expect(store.getState().auth.refreshToken).toBe('refresh-2');
    expect(window.localStorage.getItem('acme.facility.refresh')).toBe('refresh-2');
  });

  it('keeps both tokens from a login', async () => {
    const store = signedInStore();
    store.dispatch({ type: login.fulfilled.type, payload: renewed.body });
    expect(store.getState().auth.refreshToken).toBe('refresh-2');
  });
});

describe('renewing on expiry', () => {
  it('retries the original request once the session is renewed', async () => {
    let calls = 0;
    const mock = stubFetch((url) => {
      if (url.includes('/auth/refresh')) return renewed;
      calls += 1;
      return calls === 1 ? expired : page;
    });
    const store = signedInStore();

    const result = await store.dispatch(fetchIncidents());

    expect(result.meta.requestStatus).toBe('fulfilled');
    // The retry carried the renewed token, not the expired one.
    const last = mock.mock.calls.at(-1)[1];
    expect(last.headers.Authorization).toBe('Bearer access-2');
  });

  it('renews only once when several requests expire together', async () => {
    // A burst of 401s each dispatching its own renewal would spend the
    // rotating token more than once, which the API treats as a replay.
    let refreshes = 0;
    stubFetch((url) => {
      if (url.includes('/auth/refresh')) {
        refreshes += 1;
        return renewed;
      }
      return refreshes === 0 ? expired : page;
    });
    const store = signedInStore();

    await Promise.all([
      store.dispatch(fetchIncidents()),
      store.dispatch(fetchIncidents()),
      store.dispatch(fetchIncidents()),
    ]);

    expect(refreshes).toBe(1);
  });

  it('does not renew for failures that are not an expiry', async () => {
    let refreshes = 0;
    stubFetch((url) => {
      if (url.includes('/auth/refresh')) {
        refreshes += 1;
        return renewed;
      }
      return { status: 403, body: { error: { status: 403, type: 'forbidden', message: 'no', details: null } } };
    });
    const store = signedInStore();

    const result = await store.dispatch(fetchIncidents());

    expect(result.meta.requestStatus).toBe('rejected');
    expect(refreshes).toBe(0);
  });
});

describe('when renewal fails', () => {
  it('ends the session rather than looping', async () => {
    stubFetch((url) => {
      if (url.includes('/auth/refresh')) {
        return {
          status: 401,
          body: { error: { status: 401, type: 'token_reused', message: 'Session ended', details: null } },
        };
      }
      return expired;
    });
    const store = signedInStore();

    await store.dispatch(fetchIncidents());

    const { auth } = store.getState();
    expect(auth.token).toBeNull();
    expect(auth.refreshToken).toBeNull();
    expect(auth.user).toBeNull();
  });

  it('does not attempt renewal without a refresh token', async () => {
    let refreshes = 0;
    stubFetch((url) => {
      if (url.includes('/auth/refresh')) refreshes += 1;
      return expired;
    });
    const store = configureStore({
      reducer: { auth: authReducer, incidents: incidentsReducer },
      preloadedState: {
        auth: { token: 'access-1', refreshToken: null, user, status: 'idle', error: null, initialised: true },
      },
    });

    await store.dispatch(fetchIncidents());
    expect(refreshes).toBe(0);
  });
});

describe('restoring a session', () => {
  it('keeps the refresh token when the stored access token has expired', async () => {
    // Otherwise closing the tab overnight would force a sign-in, even though
    // the session is still valid and renewable.
    const store = signedInStore();
    store.dispatch({ type: loadSession.rejected.type });

    expect(store.getState().auth.token).toBeNull();
    expect(store.getState().auth.refreshToken).toBe('refresh-1');
  });

  it('clears both tokens on an explicit sign-out', () => {
    const store = signedInStore();
    store.dispatch(logout());
    expect(store.getState().auth.refreshToken).toBeNull();
    expect(window.localStorage.getItem('acme.facility.refresh')).toBeNull();
  });
});

/**
 * Authentication state: the bearer token, the signed-in profile and the
 * pending/error status of the auth calls.
 *
 * The token is mirrored into `localStorage` so a page refresh keeps the
 * session. It is restored optimistically at startup and then validated by
 * `loadSession`, which signs the user out if the token has expired.
 */

import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { request } from '../services/api';
import { refreshSession } from './session';
import { errorMessage, rejectValue } from './thunkUtils';

const TOKEN_KEY = 'acme.facility.token';
const REFRESH_KEY = 'acme.facility.refresh';

/**
 * Read the persisted token, tolerating browsers that block storage.
 *
 * @returns {string|null} The stored token, or null.
 */
function readToken(key = TOKEN_KEY) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Persist or clear the token, tolerating browsers that block storage.
 *
 * @param {string|null} token The token to store, or null to clear it.
 */
function writeToken(token, key = TOKEN_KEY) {
  try {
    if (token) window.localStorage.setItem(key, token);
    else window.localStorage.removeItem(key);
  } catch {
    // Session simply will not survive a reload; not worth failing over.
  }
}

/**
 * Store an issued session.
 *
 * The refresh token in a response replaces the one that bought it - each is
 * valid exactly once - so failing to store the replacement would make the next
 * renewal look like a replay and end the session.
 *
 * @param {object} state The auth slice state.
 * @param {object} payload A login or refresh response.
 */
function adoptSession(state, payload) {
  writeToken(payload.access_token);
  writeToken(payload.refresh_token, REFRESH_KEY);
  state.token = payload.access_token;
  state.refreshToken = payload.refresh_token;
  state.user = payload.user;
  state.initialised = true;
}

/** Sign in and store the returned token. */
export const login = createAsyncThunk('auth/login', async ({ email, password }, { rejectWithValue }) => {
  try {
    return await request('/auth/login', { method: 'POST', body: { email, password } });
  } catch (error) {
    return rejectWithValue(rejectValue(error));
  }
});

/** Register a new `@acme.inc` account, then sign in with it. */
export const register = createAsyncThunk(
  'auth/register',
  async ({ email, fullName, password }, { dispatch, rejectWithValue }) => {
    try {
      await request('/auth/register', {
        method: 'POST',
        body: { email, full_name: fullName, password },
      });
    } catch (error) {
      return rejectWithValue(rejectValue(error));
    }
    return dispatch(login({ email, password })).unwrap();
  },
);

/**
 * End the session, revoking the refresh token so it cannot be resumed.
 *
 * The local state is cleared either way: a sign-out that fails because the
 * network is down must still sign the user out of this browser.
 */
export const signOut = createAsyncThunk('auth/signOut', async (_, { getState, dispatch }) => {
  const token = getState().auth.refreshToken;
  if (token) {
    try {
      await request('/auth/logout', { method: 'POST', body: { refresh_token: token } });
    } catch {
      // Best effort: the token expires on its own soon enough.
    }
  }
  dispatch(logout());
});

/** Validate a restored token by fetching the current profile. */
export const loadSession = createAsyncThunk('auth/loadSession', async (_, { getState, rejectWithValue }) => {
  const { token } = getState().auth;
  if (!token) return null;
  try {
    return await request('/auth/me', { token });
  } catch (error) {
    return rejectWithValue(rejectValue(error));
  }
});

const initialState = {
  token: readToken(),
  refreshToken: readToken(REFRESH_KEY),
  user: null,
  status: 'idle',
  error: null,
  initialised: false,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    /** Clear the session and the persisted token. */
    logout(state) {
      writeToken(null);
      writeToken(null, REFRESH_KEY);
      state.token = null;
      state.refreshToken = null;
      state.user = null;
      state.status = 'idle';
      state.error = null;
      state.initialised = true;
    },
    /** Dismiss the current auth error, e.g. when the user edits the form. */
    clearAuthError(state) {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadSession.fulfilled, (state, action) => {
        state.user = action.payload;
        state.initialised = true;
      })
      .addCase(loadSession.rejected, (state) => {
        // The stored access token is expired or invalid. The refresh token may
        // still be good, so it is kept: the next request renews the session
        // rather than dropping the user at the login screen.
        writeToken(null);
        state.token = null;
        state.user = null;
        state.initialised = true;
      })
      .addCase(refreshSession.fulfilled, (state, action) => {
        adoptSession(state, action.payload);
        state.status = 'succeeded';
        state.error = null;
      })
      .addCase(refreshSession.rejected, (state) => {
        // The refresh token is spent, revoked or expired. Nothing can be
        // recovered, so end the session cleanly rather than looping on 401s.
        writeToken(null);
        writeToken(null, REFRESH_KEY);
        state.token = null;
        state.refreshToken = null;
        state.user = null;
        state.initialised = true;
      })
      .addMatcher(
        (action) => [login.pending.type, register.pending.type].includes(action.type),
        (state) => {
          state.status = 'loading';
          state.error = null;
        },
      )
      .addMatcher(
        (action) => [login.fulfilled.type, register.fulfilled.type].includes(action.type),
        (state, action) => {
          adoptSession(state, action.payload);
          state.status = 'succeeded';
          state.error = null;
        },
      )
      .addMatcher(
        (action) => [login.rejected.type, register.rejected.type].includes(action.type),
        (state, action) => {
          state.status = 'failed';
          state.error = errorMessage(action.payload, 'Sign in failed');
        },
      );
  },
});

export const { logout, clearAuthError } = authSlice.actions;

/** @returns {object|null} The signed-in user, or null. */
export const selectUser = (state) => state.auth.user;
/** @returns {string|null} The refresh token, or null. */
export const selectRefreshToken = (state) => state.auth.refreshToken;
/** @returns {string|null} The bearer token, or null. */
export const selectToken = (state) => state.auth.token;
/** @returns {string} The signed-in user's role, or an empty string. */
export const selectRole = (state) => state.auth.user?.role ?? '';
/** @returns {boolean} Whether the startup session check has completed. */
export const selectAuthReady = (state) => state.auth.initialised;

export default authSlice.reducer;

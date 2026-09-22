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

const TOKEN_KEY = 'acme.facility.token';

/**
 * Read the persisted token, tolerating browsers that block storage.
 *
 * @returns {string|null} The stored token, or null.
 */
function readToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist or clear the token, tolerating browsers that block storage.
 *
 * @param {string|null} token The token to store, or null to clear it.
 */
function writeToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Session simply will not survive a refresh; not worth failing over.
  }
}

/** Sign in and store the returned token. */
export const login = createAsyncThunk('auth/login', async ({ email, password }, { rejectWithValue }) => {
  try {
    return await request('/auth/login', { method: 'POST', body: { email, password } });
  } catch (error) {
    return rejectWithValue(error.describe());
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
      return rejectWithValue(error.describe());
    }
    return dispatch(login({ email, password })).unwrap();
  },
);

/** Validate a restored token by fetching the current profile. */
export const loadSession = createAsyncThunk('auth/loadSession', async (_, { getState, rejectWithValue }) => {
  const { token } = getState().auth;
  if (!token) return null;
  try {
    return await request('/auth/me', { token });
  } catch (error) {
    return rejectWithValue(error.describe());
  }
});

const initialState = {
  token: readToken(),
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
      state.token = null;
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
        // The stored token is expired or invalid: drop it silently.
        writeToken(null);
        state.token = null;
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
          writeToken(action.payload.access_token);
          state.token = action.payload.access_token;
          state.user = action.payload.user;
          state.status = 'succeeded';
          state.error = null;
          state.initialised = true;
        },
      )
      .addMatcher(
        (action) => [login.rejected.type, register.rejected.type].includes(action.type),
        (state, action) => {
          state.status = 'failed';
          state.error = action.payload ?? 'Sign in failed';
        },
      );
  },
});

export const { logout, clearAuthError } = authSlice.actions;

/** @returns {object|null} The signed-in user, or null. */
export const selectUser = (state) => state.auth.user;
/** @returns {string|null} The bearer token, or null. */
export const selectToken = (state) => state.auth.token;
/** @returns {string} The signed-in user's role, or an empty string. */
export const selectRole = (state) => state.auth.user?.role ?? '';
/** @returns {boolean} Whether the startup session check has completed. */
export const selectAuthReady = (state) => state.auth.initialised;

export default authSlice.reducer;

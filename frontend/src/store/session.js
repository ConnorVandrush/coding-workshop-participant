/**
 * Session renewal.
 *
 * Lives apart from `authSlice` so that `thunkUtils` can retry an expired
 * request without importing the slice that handles the result — the slice
 * imports this, not the other way round, which keeps the cycle out.
 */

import { createAsyncThunk } from '@reduxjs/toolkit';
import { request } from '../services/api';

/**
 * Exchange the stored refresh token for a new session.
 *
 * The response carries a replacement refresh token: each is valid exactly
 * once, so the new one must be stored or the next renewal will look like a
 * replay and end the session.
 */
export const refreshSession = createAsyncThunk(
  'auth/refresh',
  async (_, { getState, rejectWithValue }) => {
    const token = getState().auth.refreshToken;
    if (!token) return rejectWithValue({ message: 'No refresh token' });
    try {
      return await request('/auth/refresh', { method: 'POST', body: { refresh_token: token } });
    } catch (error) {
      return rejectWithValue({ message: error.message, type: error.type });
    }
  },
);

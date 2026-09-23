/**
 * Engineer roster state, including each engineer's live workload so the
 * assignment UI can show who has capacity.
 */

import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { request } from '../services/api';
import { errorMessage, withAuth } from './thunkUtils';

/**
 * Run a thunk body with the stored token, converting API errors to messages.
 *
 * @param {Function} body Receives the bearer token and performs the request.
 * @param {object} thunkApi Redux Toolkit thunk API.
 * @returns {Promise<*>} The resolved payload or a rejection with a message.
 */
async function withToken(body, thunkApi) {
  return withAuth(thunkApi, body);
}

/** Load every engineer profile. */
export const fetchEngineers = createAsyncThunk('engineers/fetchAll', async (_, thunkApi) =>
  withToken((token) => request('/engineers', { token }), thunkApi));

/** Load accounts, used to pick who to promote to engineer. */
export const fetchUsers = createAsyncThunk('engineers/fetchUsers', async (_, thunkApi) =>
  withToken((token) => request('/users?limit=200', { token }), thunkApi));

/** Promote an account to engineer and create its profile. */
export const createEngineer = createAsyncThunk('engineers/create', async (payload, thunkApi) =>
  withToken((token) => request('/engineers', { method: 'POST', body: payload, token }), thunkApi));

/** Update an engineer profile. */
export const updateEngineer = createAsyncThunk('engineers/update', async ({ id, payload }, thunkApi) =>
  withToken((token) => request(`/engineers/${id}`, { method: 'PUT', body: payload, token }), thunkApi));

/** Remove an engineer profile and demote the account. */
export const deleteEngineer = createAsyncThunk('engineers/delete', async (id, thunkApi) =>
  withToken(async (token) => {
    await request(`/engineers/${id}`, { method: 'DELETE', token });
    return id;
  }, thunkApi));

/** Change an account's role. */
export const updateUserRole = createAsyncThunk('engineers/updateUserRole', async ({ id, role }, thunkApi) =>
  withToken((token) => request(`/users/${id}/role`, { method: 'PATCH', body: { role }, token }), thunkApi));

/** Activate or deactivate an account. */
export const updateUserStatus = createAsyncThunk('engineers/updateUserStatus', async ({ id, isActive }, thunkApi) =>
  withToken((token) => request(`/users/${id}/status`, { method: 'PATCH', body: { is_active: isActive }, token }), thunkApi));

const initialState = {
  items: [],
  users: [],
  status: 'idle',
  error: null,
};

const engineersSlice = createSlice({
  name: 'engineers',
  initialState,
  extraReducers: (builder) => {
    builder
      .addCase(fetchEngineers.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchEngineers.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.items = action.payload;
      })
      .addCase(fetchEngineers.rejected, (state, action) => {
        state.status = 'failed';
        state.error = errorMessage(action.payload, 'Could not load engineers');
      })
      .addCase(fetchUsers.fulfilled, (state, action) => {
        state.users = action.payload;
      })
      .addCase(createEngineer.fulfilled, (state, action) => {
        state.items.push(action.payload);
      })
      .addCase(updateEngineer.fulfilled, (state, action) => {
        const index = state.items.findIndex((item) => item.id === action.payload.id);
        if (index !== -1) state.items[index] = action.payload;
      })
      .addCase(deleteEngineer.fulfilled, (state, action) => {
        state.items = state.items.filter((item) => item.id !== action.payload);
      })
      .addMatcher(
        (action) => [updateUserRole.fulfilled.type, updateUserStatus.fulfilled.type].includes(action.type),
        (state, action) => {
          const index = state.users.findIndex((item) => item.id === action.payload.id);
          if (index !== -1) state.users[index] = action.payload;
        },
      );
  },
  reducers: {},
});

/** @returns {Array} Engineer profiles with workload. */
export const selectEngineers = (state) => state.engineers.items;
/** @returns {Array} Accounts, for role administration. */
export const selectUsers = (state) => state.engineers.users;

export default engineersSlice.reducer;

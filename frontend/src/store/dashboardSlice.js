/**
 * Dashboard state.
 *
 * The panels load together because they answer one question as a set —
 * what is happening across the estate — and the API scopes each of them to the
 * caller's role, so an employee and an admin see the same components with
 * different numbers.
 *
 * Location hotspots used to load here. They belong to the maintenance screen,
 * where they sit beside the per-unit figures that qualify them, so that slice
 * fetches them now.
 */

import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { request } from '../services/api';
import { errorMessage, rejectValue } from './thunkUtils';

/** Load summary, SLA and (for admins) engineer workload together. */
export const fetchDashboard = createAsyncThunk(
  'dashboard/fetchAll',
  async (_, { getState, rejectWithValue }) => {
    const { token, user } = getState().auth;
    try {
      const [summary, sla] = await Promise.all([
        request('/dashboard/summary', { token }),
        request('/dashboard/sla', { token }),
      ]);
      // Workload is management information and 403s for non-admins, so it is
      // requested separately and allowed to come back empty.
      const workload =
        user?.role === 'facility_admin' ? await request('/dashboard/engineers', { token }) : [];
      return { summary, sla, workload };
    } catch (error) {
      return rejectWithValue(rejectValue(error));
    }
  },
);

/** Load the workflow graph that drives the visual state diagram. */
export const fetchWorkflow = createAsyncThunk('dashboard/fetchWorkflow', async (_, { rejectWithValue }) => {
  try {
    return await request('/workflow');
  } catch (error) {
    return rejectWithValue(rejectValue(error));
  }
});

const initialState = {
  summary: null,
  sla: null,
  workload: [],
  workflow: null,
  status: 'idle',
  error: null,
  // When the figures last arrived, so the UI can say how fresh they are.
  // Date.now() in a reducer is impure, but only affects time-travel debugging
  // and keeps the timestamp as real state rather than component bookkeeping.
  lastUpdated: null,
};

const dashboardSlice = createSlice({
  name: 'dashboard',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchDashboard.pending, (state) => {
        state.status = 'loading';
        state.error = null;
      })
      .addCase(fetchDashboard.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.summary = action.payload.summary;
        state.sla = action.payload.sla;
        state.workload = action.payload.workload;
        state.lastUpdated = Date.now();
      })
      .addCase(fetchDashboard.rejected, (state, action) => {
        state.status = 'failed';
        state.error = errorMessage(action.payload, 'Could not load the dashboard');
      })
      .addCase(fetchWorkflow.fulfilled, (state, action) => {
        state.workflow = action.payload;
      });
  },
});

/** @returns {number|null} When the figures last arrived. */
export const selectDashboardUpdatedAt = (state) => state.dashboard.lastUpdated;
/** @returns {object|null} Headline counters for the current role. */
export const selectSummary = (state) => state.dashboard.summary;
/** @returns {object|null} Average workflow durations. */
export const selectSla = (state) => state.dashboard.sla;
/** @returns {Array} Per-engineer work distribution. */
export const selectWorkload = (state) => state.dashboard.workload;
/** @returns {object|null} The incident workflow graph. */
export const selectWorkflow = (state) => state.dashboard.workflow;

export default dashboardSlice.reducer;

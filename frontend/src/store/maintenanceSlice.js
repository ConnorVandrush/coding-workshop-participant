/**
 * Maintenance state: the equipment register and what the figures say about it.
 *
 * The analytics and the register load together, because the screen is one
 * argument — these units keep failing, here is the register they came from —
 * and splitting the requests would let the tables disagree with each other on
 * screen while the second one was still in flight.
 *
 * Hotspots are fetched from `/dashboard/hotspots` rather than duplicated under
 * `/maintenance`: they answer where faults are *reported*, which is a different
 * question from which unit is failing, and one endpoint is easier to keep true
 * than two.
 */

import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { request, toQuery } from '../services/api';
import { rejectValue, withAuth } from './thunkUtils';

/** Default recency window, matching the API's own default. */
export const DEFAULT_WINDOW_DAYS = 90;

/** Load the summary, the ranked units, reliability by class and the hotspots. */
export const fetchMaintenance = createAsyncThunk(
  'maintenance/fetchAll',
  async (windowDays = DEFAULT_WINDOW_DAYS, { getState, rejectWithValue }) => {
    const { token } = getState().auth;
    const query = toQuery({ window_days: windowDays });
    try {
      const [summary, review, types, hotspots] = await Promise.all([
        request(`/maintenance/summary${query}`, { token }),
        request(`/maintenance/assets/review${query}&limit=50`, { token }),
        request(`/maintenance/types${query}`, { token }),
        request('/dashboard/hotspots?limit=5', { token }),
      ]);
      return { summary, review, types, hotspots };
    } catch (error) {
      return rejectWithValue(rejectValue(error));
    }
  },
);

/** Load the equipment register, optionally filtered. */
export const fetchAssets = createAsyncThunk('maintenance/fetchAssets', async (params, thunkApi) =>
  withAuth(thunkApi, (token) => request(`/assets${toQuery(params)}`, { token })));

/** Register a unit of equipment. */
export const createAsset = createAsyncThunk('maintenance/createAsset', async (payload, thunkApi) =>
  withAuth(thunkApi, (token) => request('/assets', { method: 'POST', body: payload, token })));

/** Update a unit — most often to retire it. */
export const updateAsset = createAsyncThunk('maintenance/updateAsset', async ({ id, payload }, thunkApi) =>
  withAuth(thunkApi, (token) => request(`/assets/${id}`, { method: 'PUT', body: payload, token })));

/** Record that a unit was serviced, which restarts its interval. */
export const recordService = createAsyncThunk('maintenance/recordService', async ({ id, note }, thunkApi) =>
  withAuth(thunkApi, (token) =>
    request(`/assets/${id}/service`, { method: 'POST', body: { note: note ?? null }, token })));

/** Remove a unit from the register, leaving its incidents intact. */
export const deleteAsset = createAsyncThunk('maintenance/deleteAsset', async (id, thunkApi) =>
  withAuth(thunkApi, async (token) => {
    await request(`/assets/${id}`, { method: 'DELETE', token });
    return id;
  }));

const initialState = {
  summary: null,
  review: null,
  types: [],
  hotspots: null,
  assets: [],
  windowDays: DEFAULT_WINDOW_DAYS,
  status: 'idle',
  assetsStatus: 'idle',
  error: null,
  saving: false,
};

const maintenanceSlice = createSlice({
  name: 'maintenance',
  initialState,
  reducers: {
    /**
     * Change the recency window the figures are taken over.
     *
     * @param {object} state Current state.
     * @param {object} action Action carrying the number of days.
     */
    setWindowDays(state, action) {
      state.windowDays = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchMaintenance.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchMaintenance.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.summary = action.payload.summary;
        state.review = action.payload.review;
        state.types = action.payload.types;
        state.hotspots = action.payload.hotspots;
        state.error = null;
      })
      .addCase(fetchMaintenance.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload;
      })
      .addCase(fetchAssets.pending, (state) => {
        state.assetsStatus = 'loading';
      })
      .addCase(fetchAssets.fulfilled, (state, action) => {
        state.assetsStatus = 'succeeded';
        state.assets = action.payload;
      })
      .addCase(fetchAssets.rejected, (state) => {
        state.assetsStatus = 'failed';
      })
      // Handled on its own rather than in the loop below, because it drops the
      // row as well as clearing the saving flag, and a second `addCase` for the
      // same action type is an error rather than a second handler.
      .addCase(deleteAsset.pending, (state) => {
        state.saving = true;
      })
      .addCase(deleteAsset.fulfilled, (state, action) => {
        state.saving = false;
        state.assets = state.assets.filter((asset) => asset.id !== action.payload);
      })
      .addCase(deleteAsset.rejected, (state) => {
        state.saving = false;
      });

    // Any write leaves the analytics stale, so the page refetches after one.
    [createAsset, updateAsset, recordService].forEach((thunk) => {
      builder
        .addCase(thunk.pending, (state) => {
          state.saving = true;
        })
        .addCase(thunk.fulfilled, (state) => {
          state.saving = false;
        })
        .addCase(thunk.rejected, (state) => {
          state.saving = false;
        });
    });
  },
});

export const { setWindowDays } = maintenanceSlice.actions;

/** @returns {object|null} Headline maintenance figures. */
export const selectMaintenanceSummary = (state) => state.maintenance.summary;
/** @returns {object|null} Ranked units, with the window they were ranked over. */
export const selectAssetReview = (state) => state.maintenance.review;
/** @returns {Array} Reliability per equipment class. */
export const selectTypeReliability = (state) => state.maintenance.types;
/** @returns {object|null} Location hotspots. */
export const selectMaintenanceHotspots = (state) => state.maintenance.hotspots;
/** @returns {Array} The equipment register. */
export const selectAssets = (state) => state.maintenance.assets;

export default maintenanceSlice.reducer;

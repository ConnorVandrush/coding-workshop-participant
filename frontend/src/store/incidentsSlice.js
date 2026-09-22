/**
 * Incident state: the filtered list, the incident currently open in the detail
 * view, and its notes.
 *
 * Filters live in the store rather than in component state so that the list
 * page, the URL-less "back" navigation from a detail view, and the dashboard's
 * drill-down links all agree on what is being shown.
 */

import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { request, toQuery } from '../services/api';
import { errorMessage, rejectValue } from './thunkUtils';

/** Filter values meaning "show everything". */
export const DEFAULT_FILTERS = {
  q: '',
  status: '',
  priority: '',
  category: '',
  building_id: '',
  assignee_id: '',
  is_escalated: '',
  unassigned: '',
  sort: 'created_at',
  order: 'desc',
};

const PAGE_SIZE = 25;

/**
 * Run a thunk body with the stored token, converting API errors to messages.
 *
 * @param {Function} body Receives the bearer token and performs the request.
 * @param {object} thunkApi Redux Toolkit thunk API.
 * @returns {Promise<*>} The resolved payload or a rejection with a message.
 */
async function withToken(body, { getState, rejectWithValue }) {
  try {
    return await body(getState().auth.token);
  } catch (error) {
    return rejectWithValue(rejectValue(error));
  }
}

/** Load a page of incidents using the filters currently in the store. */
export const fetchIncidents = createAsyncThunk('incidents/fetchAll', async (overrides = {}, thunkApi) =>
  withToken((token) => {
    const { filters, page } = thunkApi.getState().incidents;
    const merged = { ...filters, ...overrides };
    const query = toQuery({ ...merged, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    return request(`/incidents${query}`, { token });
  }, thunkApi));

/** Load one incident by id. */
export const fetchIncident = createAsyncThunk('incidents/fetchOne', async (incidentId, thunkApi) =>
  withToken((token) => request(`/incidents/${incidentId}`, { token }), thunkApi));

/** Report a new incident. */
export const createIncident = createAsyncThunk('incidents/create', async (payload, thunkApi) =>
  withToken((token) => request('/incidents', { method: 'POST', body: payload, token }), thunkApi));

/** Update an incident's descriptive fields. */
export const updateIncident = createAsyncThunk('incidents/update', async ({ incidentId, payload }, thunkApi) =>
  withToken((token) => request(`/incidents/${incidentId}`, { method: 'PUT', body: payload, token }), thunkApi));

/** Delete an incident (facility admins only). */
export const deleteIncident = createAsyncThunk('incidents/delete', async (incidentId, thunkApi) =>
  withToken(async (token) => {
    await request(`/incidents/${incidentId}`, { method: 'DELETE', token });
    return incidentId;
  }, thunkApi));

/** Assign or unassign an engineer. */
export const assignIncident = createAsyncThunk('incidents/assign', async ({ incidentId, engineerId, note }, thunkApi) =>
  withToken(
    (token) =>
      request(`/incidents/${incidentId}/assign`, {
        method: 'POST',
        body: { engineer_id: engineerId, note },
        token,
      }),
    thunkApi,
  ));

/** Drive the workflow to a new status. */
export const changeStatus = createAsyncThunk('incidents/changeStatus', async ({ incidentId, ...body }, thunkApi) =>
  withToken((token) => request(`/incidents/${incidentId}/status`, { method: 'POST', body, token }), thunkApi));

/** Raise or clear an escalation. */
export const escalateIncident = createAsyncThunk('incidents/escalate', async ({ incidentId, ...body }, thunkApi) =>
  withToken((token) => request(`/incidents/${incidentId}/escalate`, { method: 'POST', body, token }), thunkApi));

/** Load the notes attached to an incident. */
export const fetchNotes = createAsyncThunk('incidents/fetchNotes', async (incidentId, thunkApi) =>
  withToken((token) => request(`/incidents/${incidentId}/notes`, { token }), thunkApi));

/** Add a note to an incident. */
export const addNote = createAsyncThunk('incidents/addNote', async ({ incidentId, body, isInternal }, thunkApi) =>
  withToken(
    (token) =>
      request(`/incidents/${incidentId}/notes`, {
        method: 'POST',
        body: { body, is_internal: Boolean(isInternal) },
        token,
      }),
    thunkApi,
  ));

const initialState = {
  items: [],
  total: 0,
  page: 0,
  pageSize: PAGE_SIZE,
  filters: { ...DEFAULT_FILTERS },
  listStatus: 'idle',
  listError: null,
  current: null,
  currentStatus: 'idle',
  notes: [],
  saving: false,
  // When each view last arrived, so the UI can say how fresh it is.
  listUpdatedAt: null,
  currentUpdatedAt: null,
};

const incidentsSlice = createSlice({
  name: 'incidents',
  initialState,
  reducers: {
    /** Replace one or more filters and return to the first page. */
    setFilters(state, action) {
      state.filters = { ...state.filters, ...action.payload };
      state.page = 0;
    },
    /** Reset every filter to its "show everything" value. */
    resetFilters(state) {
      state.filters = { ...DEFAULT_FILTERS };
      state.page = 0;
    },
    /** Move to a zero-based page of results. */
    setPage(state, action) {
      state.page = action.payload;
    },
    /** Drop the incident held for the detail view. */
    clearCurrent(state) {
      state.current = null;
      state.notes = [];
      state.currentStatus = 'idle';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchIncidents.pending, (state) => {
        state.listStatus = 'loading';
        state.listError = null;
      })
      .addCase(fetchIncidents.fulfilled, (state, action) => {
        state.listStatus = 'succeeded';
        state.items = action.payload.items;
        state.total = action.payload.total;
        state.listUpdatedAt = Date.now();
      })
      .addCase(fetchIncidents.rejected, (state, action) => {
        state.listStatus = 'failed';
        state.listError = errorMessage(action.payload, 'Could not load incidents');
      })
      .addCase(fetchIncident.pending, (state) => {
        state.currentStatus = 'loading';
      })
      .addCase(fetchIncident.fulfilled, (state, action) => {
        state.currentStatus = 'succeeded';
        state.current = action.payload;
        state.currentUpdatedAt = Date.now();
      })
      .addCase(fetchIncident.rejected, (state) => {
        state.currentStatus = 'failed';
        state.current = null;
      })
      .addCase(fetchNotes.fulfilled, (state, action) => {
        state.notes = action.payload;
      })
      .addCase(addNote.fulfilled, (state, action) => {
        state.notes.push(action.payload);
        if (state.current) state.current.note_count += 1;
      })
      .addCase(deleteIncident.fulfilled, (state, action) => {
        state.items = state.items.filter((item) => item.id !== action.payload);
        state.total = Math.max(0, state.total - 1);
        state.current = null;
      })
      .addMatcher(
        (action) => action.type.startsWith('incidents/') && action.type.endsWith('/pending'),
        (state, action) => {
          // List and detail loads have their own flags; everything else is a write.
          if (!action.type.startsWith('incidents/fetch')) state.saving = true;
        },
      )
      .addMatcher(
        (action) =>
          action.type.startsWith('incidents/') &&
          (action.type.endsWith('/fulfilled') || action.type.endsWith('/rejected')),
        (state) => {
          state.saving = false;
        },
      )
      .addMatcher(
        (action) =>
          [
            updateIncident.fulfilled.type,
            assignIncident.fulfilled.type,
            changeStatus.fulfilled.type,
            escalateIncident.fulfilled.type,
          ].includes(action.type),
        (state, action) => {
          // Every write returns the full incident, so the detail view and the
          // matching row in the list can both be refreshed without a re-fetch.
          state.current = action.payload;
          const index = state.items.findIndex((item) => item.id === action.payload.id);
          if (index !== -1) state.items[index] = action.payload;
        },
      );
  },
});

export const { setFilters, resetFilters, setPage, clearCurrent } = incidentsSlice.actions;

/** @returns {number|null} When the list last arrived. */
export const selectListUpdatedAt = (state) => state.incidents.listUpdatedAt;
/** @returns {number|null} When the open incident last arrived. */
export const selectCurrentUpdatedAt = (state) => state.incidents.currentUpdatedAt;
/** @returns {Array} The incidents on the current page. */
export const selectIncidents = (state) => state.incidents.items;
/** @returns {object} The active filter values. */
export const selectFilters = (state) => state.incidents.filters;
/** @returns {object|null} The incident open in the detail view. */
export const selectCurrentIncident = (state) => state.incidents.current;
/** @returns {Array} Notes for the incident in the detail view. */
export const selectNotes = (state) => state.incidents.notes;

export default incidentsSlice.reducer;

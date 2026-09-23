/**
 * Facility hierarchy state: buildings, and the floors and seats of whichever
 * building is currently selected.
 *
 * Floors and seats are loaded lazily per building rather than all at once,
 * mirroring how the API nests them.
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

/** Load every building. */
export const fetchBuildings = createAsyncThunk('facilities/fetchBuildings', async (_, thunkApi) =>
  withToken((token) => request('/buildings', { token }), thunkApi));

/** Create a building. */
export const createBuilding = createAsyncThunk('facilities/createBuilding', async (payload, thunkApi) =>
  withToken((token) => request('/buildings', { method: 'POST', body: payload, token }), thunkApi));

/** Update a building. */
export const updateBuilding = createAsyncThunk('facilities/updateBuilding', async ({ id, payload }, thunkApi) =>
  withToken((token) => request(`/buildings/${id}`, { method: 'PUT', body: payload, token }), thunkApi));

/** Delete a building and everything under it. */
export const deleteBuilding = createAsyncThunk('facilities/deleteBuilding', async (id, thunkApi) =>
  withToken(async (token) => {
    await request(`/buildings/${id}`, { method: 'DELETE', token });
    return id;
  }, thunkApi));

/** Load the floors of a building. */
export const fetchFloors = createAsyncThunk('facilities/fetchFloors', async (buildingId, thunkApi) =>
  withToken((token) => request(`/buildings/${buildingId}/floors`, { token }), thunkApi));

/** Add a floor to a building. */
export const createFloor = createAsyncThunk('facilities/createFloor', async ({ buildingId, payload }, thunkApi) =>
  withToken((token) => request(`/buildings/${buildingId}/floors`, { method: 'POST', body: payload, token }), thunkApi));

/** Delete a floor and its seats. */
export const deleteFloor = createAsyncThunk('facilities/deleteFloor', async (id, thunkApi) =>
  withToken(async (token) => {
    await request(`/floors/${id}`, { method: 'DELETE', token });
    return id;
  }, thunkApi));

/** Load the seats on a floor. */
export const fetchSeats = createAsyncThunk('facilities/fetchSeats', async (floorId, thunkApi) =>
  withToken(async (token) => ({ floorId, seats: await request(`/floors/${floorId}/seats`, { token }) }), thunkApi));

/** Add a seat to a floor. */
export const createSeat = createAsyncThunk('facilities/createSeat', async ({ floorId, payload }, thunkApi) =>
  withToken(
    async (token) => ({
      floorId,
      seat: await request(`/floors/${floorId}/seats`, { method: 'POST', body: payload, token }),
    }),
    thunkApi,
  ));

/** Delete a seat. */
export const deleteSeat = createAsyncThunk('facilities/deleteSeat', async ({ floorId, seatId }, thunkApi) =>
  withToken(async (token) => {
    await request(`/seats/${seatId}`, { method: 'DELETE', token });
    return { floorId, seatId };
  }, thunkApi));

const initialState = {
  buildings: [],
  floors: [],
  seatsByFloor: {},
  selectedBuildingId: null,
  status: 'idle',
  error: null,
};

const facilitiesSlice = createSlice({
  name: 'facilities',
  initialState,
  reducers: {
    /** Select a building, clearing the previously loaded floors and seats. */
    selectBuilding(state, action) {
      state.selectedBuildingId = action.payload;
      state.floors = [];
      state.seatsByFloor = {};
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchBuildings.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchBuildings.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.buildings = action.payload;
      })
      .addCase(fetchBuildings.rejected, (state, action) => {
        state.status = 'failed';
        state.error = errorMessage(action.payload, 'Could not load buildings');
      })
      .addCase(createBuilding.fulfilled, (state, action) => {
        state.buildings.push(action.payload);
      })
      .addCase(updateBuilding.fulfilled, (state, action) => {
        const index = state.buildings.findIndex((item) => item.id === action.payload.id);
        if (index !== -1) state.buildings[index] = action.payload;
      })
      .addCase(deleteBuilding.fulfilled, (state, action) => {
        state.buildings = state.buildings.filter((item) => item.id !== action.payload);
        if (state.selectedBuildingId === action.payload) {
          state.selectedBuildingId = null;
          state.floors = [];
        }
      })
      .addCase(fetchFloors.fulfilled, (state, action) => {
        state.floors = action.payload;
      })
      .addCase(createFloor.fulfilled, (state, action) => {
        state.floors.push(action.payload);
        state.floors.sort((a, b) => a.level - b.level);
      })
      .addCase(deleteFloor.fulfilled, (state, action) => {
        state.floors = state.floors.filter((item) => item.id !== action.payload);
        delete state.seatsByFloor[action.payload];
      })
      .addCase(fetchSeats.fulfilled, (state, action) => {
        state.seatsByFloor[action.payload.floorId] = action.payload.seats;
      })
      .addCase(createSeat.fulfilled, (state, action) => {
        const list = state.seatsByFloor[action.payload.floorId] ?? [];
        state.seatsByFloor[action.payload.floorId] = [...list, action.payload.seat];
        const floor = state.floors.find((item) => item.id === action.payload.floorId);
        if (floor) floor.seat_count += 1;
      })
      .addCase(deleteSeat.fulfilled, (state, action) => {
        const { floorId, seatId } = action.payload;
        state.seatsByFloor[floorId] = (state.seatsByFloor[floorId] ?? []).filter((item) => item.id !== seatId);
        const floor = state.floors.find((item) => item.id === floorId);
        if (floor) floor.seat_count = Math.max(0, floor.seat_count - 1);
      });
  },
});

export const { selectBuilding } = facilitiesSlice.actions;

/** @returns {Array} All buildings. */
export const selectBuildings = (state) => state.facilities.buildings;
/** @returns {Array} Floors of the selected building. */
export const selectFloors = (state) => state.facilities.floors;

export default facilitiesSlice.reducer;

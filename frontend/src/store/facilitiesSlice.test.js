/**
 * Tests for the facilities slice.
 *
 * The hierarchy is loaded lazily - floors for the selected building, seats for
 * the expanded floor - so the reducers maintain denormalised counts and nested
 * state that drift easily if a case is missed.
 */

import { describe, expect, it } from 'vitest';
import reducer, {
  createBuilding,
  createFloor,
  createSeat,
  deleteBuilding,
  deleteFloor,
  deleteSeat,
  fetchBuildings,
  fetchFloors,
  fetchSeats,
  selectBuilding,
  updateBuilding,
} from './facilitiesSlice';

const building = (id, name = `Building ${id}`) => ({ id, name, address: null, floor_count: 0 });
const floor = (id, buildingId, level, seatCount = 0) => ({
  id, building_id: buildingId, level, name: null, seat_count: seatCount,
});
const seat = (id, floorId, code) => ({ id, floor_id: floorId, code });

/** @returns {object} A fresh initial state. */
const initial = () => reducer(undefined, { type: '@@INIT' });

describe('buildings', () => {
  it('records the loaded list', () => {
    const state = reducer(initial(), { type: fetchBuildings.fulfilled.type, payload: [building(1)] });
    expect(state.status).toBe('succeeded');
    expect(state.buildings).toHaveLength(1);
  });

  it('surfaces a load failure', () => {
    const state = reducer(initial(), { type: fetchBuildings.rejected.type, payload: { message: 'nope' } });
    expect(state.status).toBe('failed');
    expect(state.error).toBe('nope');
  });

  it('falls back to a default message when a rejection carries none', () => {
    const state = reducer(initial(), { type: fetchBuildings.rejected.type });
    expect(state.error).toBe('Could not load buildings');
  });

  it('appends a created building', () => {
    const state = reducer(initial(), { type: createBuilding.fulfilled.type, payload: building(1) });
    expect(state.buildings).toHaveLength(1);
  });

  it('replaces an updated building in place', () => {
    const before = { ...initial(), buildings: [building(1, 'Old'), building(2)] };
    const state = reducer(before, { type: updateBuilding.fulfilled.type, payload: building(1, 'New') });
    expect(state.buildings[0].name).toBe('New');
    expect(state.buildings[1].id).toBe(2);
  });

  it('removes a deleted building and clears the selection when it was selected', () => {
    const before = { ...initial(), buildings: [building(1), building(2)], selectedBuildingId: 1, floors: [floor(10, 1, 3)] };
    const state = reducer(before, { type: deleteBuilding.fulfilled.type, payload: 1 });
    expect(state.buildings.map((b) => b.id)).toEqual([2]);
    expect(state.selectedBuildingId).toBeNull();
    expect(state.floors).toEqual([]);
  });

  it('keeps the selection when a different building is deleted', () => {
    const before = { ...initial(), buildings: [building(1), building(2)], selectedBuildingId: 2, floors: [floor(10, 2, 3)] };
    const state = reducer(before, { type: deleteBuilding.fulfilled.type, payload: 1 });
    expect(state.selectedBuildingId).toBe(2);
    expect(state.floors).toHaveLength(1);
  });
});

describe('selecting a building', () => {
  it('discards the previous building floors and seats', () => {
    // Otherwise the newly selected building briefly shows another one's floors.
    const before = { ...initial(), floors: [floor(10, 1, 3)], seatsByFloor: { 10: [seat(100, 10, 'A')] } };
    const state = reducer(before, selectBuilding(2));
    expect(state.selectedBuildingId).toBe(2);
    expect(state.floors).toEqual([]);
    expect(state.seatsByFloor).toEqual({});
  });
});

describe('floors', () => {
  it('records the loaded floors', () => {
    const state = reducer(initial(), { type: fetchFloors.fulfilled.type, payload: [floor(10, 1, 3)] });
    expect(state.floors).toHaveLength(1);
  });

  it('keeps floors ordered by level when one is added', () => {
    const before = { ...initial(), floors: [floor(10, 1, 1), floor(11, 1, 5)] };
    const state = reducer(before, { type: createFloor.fulfilled.type, payload: floor(12, 1, 3) });
    expect(state.floors.map((f) => f.level)).toEqual([1, 3, 5]);
  });

  it('drops a deleted floor and the seats cached for it', () => {
    const before = { ...initial(), floors: [floor(10, 1, 3)], seatsByFloor: { 10: [seat(100, 10, 'A')] } };
    const state = reducer(before, { type: deleteFloor.fulfilled.type, payload: 10 });
    expect(state.floors).toEqual([]);
    expect(state.seatsByFloor[10]).toBeUndefined();
  });
});

describe('seats', () => {
  it('caches seats under their floor', () => {
    const state = reducer(initial(), {
      type: fetchSeats.fulfilled.type,
      payload: { floorId: 10, seats: [seat(100, 10, 'A')] },
    });
    expect(state.seatsByFloor[10]).toHaveLength(1);
  });

  it('adds a seat and increments its floor count', () => {
    const before = { ...initial(), floors: [floor(10, 1, 3, 1)], seatsByFloor: { 10: [seat(100, 10, 'A')] } };
    const state = reducer(before, {
      type: createSeat.fulfilled.type,
      payload: { floorId: 10, seat: seat(101, 10, 'B') },
    });
    expect(state.seatsByFloor[10]).toHaveLength(2);
    expect(state.floors[0].seat_count).toBe(2);
  });

  it('adds a seat to a floor with nothing cached yet', () => {
    const state = reducer(initial(), {
      type: createSeat.fulfilled.type,
      payload: { floorId: 10, seat: seat(101, 10, 'B') },
    });
    expect(state.seatsByFloor[10]).toHaveLength(1);
  });

  it('removes a seat and decrements its floor count', () => {
    const before = { ...initial(), floors: [floor(10, 1, 3, 2)], seatsByFloor: { 10: [seat(100, 10, 'A'), seat(101, 10, 'B')] } };
    const state = reducer(before, { type: deleteSeat.fulfilled.type, payload: { floorId: 10, seatId: 100 } });
    expect(state.seatsByFloor[10].map((s) => s.id)).toEqual([101]);
    expect(state.floors[0].seat_count).toBe(1);
  });

  it('never drives a seat count below zero', () => {
    const before = { ...initial(), floors: [floor(10, 1, 3, 0)], seatsByFloor: {} };
    const state = reducer(before, { type: deleteSeat.fulfilled.type, payload: { floorId: 10, seatId: 999 } });
    expect(state.floors[0].seat_count).toBe(0);
  });
});

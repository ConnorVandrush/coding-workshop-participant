/**
 * Transient UI state: the toast queue and the mobile navigation drawer.
 *
 * Keeping feedback in the store means any thunk can report success or failure
 * without the calling component having to own a snackbar.
 */

import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  toast: null,
  drawerOpen: false,
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    /**
     * Show a toast.
     *
     * @param {object} state Current slice state.
     * @param {object} action `{payload: {message, severity}}` where severity is
     *   one of `success`, `info`, `warning` or `error`.
     */
    notify(state, action) {
      const { message, severity = 'info' } = action.payload;
      state.toast = { message, severity, key: Date.now() };
    },
    /** Dismiss the current toast. */
    dismissToast(state) {
      state.toast = null;
    },
    /** Open or close the mobile navigation drawer. */
    setDrawerOpen(state, action) {
      state.drawerOpen = action.payload;
    },
  },
});

export const { notify, dismissToast, setDrawerOpen } = uiSlice.actions;

/** @returns {object|null} The toast to display, if any. */
export const selectToast = (state) => state.ui.toast;
/** @returns {boolean} Whether the mobile drawer is open. */
export const selectDrawerOpen = (state) => state.ui.drawerOpen;

export default uiSlice.reducer;

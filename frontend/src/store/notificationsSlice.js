/**
 * The signed-in user's notification feed.
 *
 * Rows are written asynchronously by the notifier worker, so the feed is
 * polled like the rest of the live data rather than pushed.
 */

import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { request, toQuery } from '../services/api';
import { errorMessage, rejectValue } from './thunkUtils';

/** Load the feed and the unread count. */
export const fetchNotifications = createAsyncThunk(
  'notifications/fetch',
  async (_, { getState, rejectWithValue }) => {
    try {
      return await request(`/notifications${toQuery({ limit: 20 })}`, {
        token: getState().auth.token,
      });
    } catch (error) {
      return rejectWithValue(rejectValue(error));
    }
  },
);

/** Mark one notification as read. */
export const markRead = createAsyncThunk(
  'notifications/markRead',
  async (notificationId, { getState, rejectWithValue }) => {
    try {
      return await request(`/notifications/${notificationId}/read`, {
        method: 'POST',
        token: getState().auth.token,
      });
    } catch (error) {
      return rejectWithValue(rejectValue(error));
    }
  },
);

/** Mark the whole feed as read. */
export const markAllRead = createAsyncThunk(
  'notifications/markAllRead',
  async (_, { getState, rejectWithValue }) => {
    try {
      return await request('/notifications/read-all', {
        method: 'POST',
        token: getState().auth.token,
      });
    } catch (error) {
      return rejectWithValue(rejectValue(error));
    }
  },
);

const initialState = {
  items: [],
  unread: 0,
  status: 'idle',
  error: null,
};

const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchNotifications.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchNotifications.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.items = action.payload.items;
        state.unread = action.payload.unread;
      })
      .addCase(fetchNotifications.rejected, (state, action) => {
        state.status = 'failed';
        state.error = errorMessage(action.payload, 'Could not load notifications');
      })
      .addCase(markRead.fulfilled, (state, action) => {
        const index = state.items.findIndex((item) => item.id === action.payload.id);
        if (index !== -1) state.items[index] = action.payload;
        state.unread = Math.max(0, state.unread - 1);
      })
      .addCase(markAllRead.fulfilled, (state) => {
        state.items = state.items.map((item) => ({ ...item, is_read: true }));
        state.unread = 0;
      });
  },
});

/** @returns {Array} The notifications on the feed. */
export const selectNotifications = (state) => state.notifications.items;
/** @returns {number} How many are unread. */
export const selectUnreadCount = (state) => state.notifications.unread;

export default notificationsSlice.reducer;

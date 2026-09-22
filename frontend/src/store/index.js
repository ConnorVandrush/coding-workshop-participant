/**
 * Redux store composition.
 *
 * State is split by domain so that each page subscribes only to the slice it
 * renders, and so that the async thunks stay close to the data they own.
 */

import { configureStore } from '@reduxjs/toolkit';
import authReducer from './authSlice';
import dashboardReducer from './dashboardSlice';
import engineersReducer from './engineersSlice';
import facilitiesReducer from './facilitiesSlice';
import incidentsReducer from './incidentsSlice';
import notificationsReducer from './notificationsSlice';
import uiReducer from './uiSlice';

const store = configureStore({
  reducer: {
    auth: authReducer,
    incidents: incidentsReducer,
    facilities: facilitiesReducer,
    engineers: engineersReducer,
    dashboard: dashboardReducer,
    notifications: notificationsReducer,
    ui: uiReducer,
  },
});

export default store;

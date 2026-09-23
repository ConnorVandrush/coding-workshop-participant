/**
 * Shared helpers for page-level tests.
 *
 * Pages dispatch thunks on mount and render several panels from several
 * endpoints, so these helpers provide a real store, a router, the application
 * theme, and a small fake API keyed by method and path. Only `fetch` is
 * stubbed - the slices, thunks and components under test are the real ones.
 */

import { ThemeProvider } from '@mui/material/styles';
import { configureStore } from '@reduxjs/toolkit';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import Notifier from '../components/Notifier';
import { API_BASE } from '../services/api';
import authReducer from '../store/authSlice';
import dashboardReducer from '../store/dashboardSlice';
import engineersReducer from '../store/engineersSlice';
import facilitiesReducer from '../store/facilitiesSlice';
import incidentsReducer from '../store/incidentsSlice';
import maintenanceReducer from '../store/maintenanceSlice';
import notificationsReducer from '../store/notificationsSlice';
import uiReducer from '../store/uiSlice';
import theme from '../theme';

/** A facility admin, the persona with the widest permissions. */
export const ADMIN = {
  id: 1, email: 'admin@acme.inc', full_name: 'Ada Admin', role: 'facility_admin', is_active: true,
  created_at: '2026-09-01T09:00:00Z',
};
/** An employee: sees only their own incidents and no administration. */
export const EMPLOYEE = {
  id: 2, email: 'dana.ruiz@acme.inc', full_name: 'Dana Ruiz', role: 'employee', is_active: true,
  created_at: '2026-09-02T09:00:00Z',
};
/** An engineer: manages assigned work. */
export const ENGINEER = {
  id: 3, email: 'sam.okafor@acme.inc', full_name: 'Sam Okafor', role: 'engineer', is_active: true,
  created_at: '2026-09-03T09:00:00Z',
};

/**
 * Turn a route pattern into an anchored regular expression.
 *
 * `:id` segments match any single path segment, so `/incidents/:id/notes`
 * matches `/incidents/42/notes` but not `/incidents/42`.
 *
 * @param {string} pattern Path pattern, e.g. `/incidents/:id`.
 * @returns {RegExp} The compiled matcher.
 */
function toMatcher(pattern) {
  return new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`);
}

/**
 * Stub `fetch` with a tiny fake API.
 *
 * @param {object} handlers Map of `"METHOD /path"` to a body, or to
 *   `{status, body}` when the status matters.
 * @returns {import('vitest').Mock} The stub, for asserting on calls.
 */
export function mockApi(handlers) {
  const routes = Object.entries(handlers).map(([key, value]) => {
    const [method, pattern] = key.split(' ');
    return { method, matcher: toMatcher(pattern), value };
  });

  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = String(url).replace(API_BASE, '').split('?')[0];
    const route = routes.find((r) => r.method === method && r.matcher.test(path));

    if (!route) {
      // Surfacing unmatched calls as 404 keeps a missing handler visible in the
      // UI as an error rather than as a silent hang.
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({
          error: { status: 404, type: 'not_found', message: `No handler for ${method} ${path}`, details: null },
        }),
      };
    }

    // A handler value is a response envelope only when it carries BOTH keys.
    // Testing for `status` alone misreads any domain object with a status
    // field - an incident's status is "IN_PROGRESS", which is not an HTTP
    // code - and silently returns an empty body.
    const isEnvelope = typeof route.value === 'object'
      && route.value !== null
      && 'status' in route.value
      && 'body' in route.value;
    const { status = 200, body } = isEnvelope ? route.value : { status: 200, body: route.value };

    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    };
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Render a page with the real store, router and theme.
 *
 * @param {React.ReactElement} ui The element under test.
 * @param {object} [options] Render options.
 * @param {object} [options.user] The signed-in user; defaults to the admin.
 * @param {string} [options.route] Initial location.
 * @param {string} [options.path] Route path, for pages that read URL params.
 * @param {object} [options.preloadedState] Extra slice state to seed.
 * @returns {object} Testing Library result plus the store and a location probe.
 */
export function renderPage(ui, { user = ADMIN, route = '/', path = '*', preloadedState = {} } = {}) {
  const store = configureStore({
    reducer: {
      auth: authReducer,
      incidents: incidentsReducer,
      facilities: facilitiesReducer,
      engineers: engineersReducer,
      dashboard: dashboardReducer,
      maintenance: maintenanceReducer,
      notifications: notificationsReducer,
      ui: uiReducer,
    },
    preloadedState: {
      auth: { token: 'test-token', user, status: 'succeeded', error: null, initialised: true },
      ...preloadedState,
    },
  });

  const result = render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path={path} element={ui} />
            <Route path="/incidents" element={<div>incidents list page</div>} />
            <Route path="/incidents/:incidentId" element={<div>incident detail page</div>} />
          </Routes>
          {/* Mounted in AppLayout in the real app, so pages can report success
              and failure through notify() without owning a snackbar. */}
          <Notifier />
        </MemoryRouter>
      </ThemeProvider>
    </Provider>,
  );

  return { ...result, store };
}

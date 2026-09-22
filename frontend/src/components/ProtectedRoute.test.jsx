/**
 * Tests for the route guard.
 *
 * This is a usability layer, not the security boundary - the API independently
 * rejects anything a role may not do. What these tests protect is that the app
 * never renders a page which can only produce 403s, and never decides on a role
 * before the restored session has been validated.
 */

import { expect, it } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import ProtectedRoute from './ProtectedRoute';
import authReducer from '../store/authSlice';

/**
 * Render a guarded route with a given auth state.
 *
 * @param {object} auth Partial auth slice state.
 * @param {string[]} [roles] Roles the guard should admit.
 */
function renderGuarded(auth, roles = []) {
  const store = configureStore({
    reducer: { auth: authReducer },
    preloadedState: {
      auth: { token: null, user: null, status: 'idle', error: null, initialised: false, ...auth },
    },
  });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/secret']}>
        <Routes>
          <Route path="/login" element={<div>login page</div>} />
          <Route path="/" element={<div>dashboard</div>} />
          <Route
            path="/secret"
            element={
              <ProtectedRoute roles={roles}>
                <div>secret content</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

const admin = { id: 1, role: 'facility_admin', full_name: 'Ada', email: 'a@acme.inc' };
const employee = { id: 2, role: 'employee', full_name: 'Dana', email: 'd@acme.inc' };

it('sends an anonymous visitor to the login page', () => {
  renderGuarded({ token: null });
  expect(screen.getByText('login page')).toBeInTheDocument();
  expect(screen.queryByText('secret content')).not.toBeInTheDocument();
});

it('waits for the session check before judging the role', () => {
  // Deciding while `initialised` is false would bounce a legitimate admin to
  // the dashboard on every hard refresh, because the role is not known yet.
  renderGuarded({ token: 'tok', user: null, initialised: false }, ['facility_admin']);
  expect(screen.queryByText('secret content')).not.toBeInTheDocument();
  expect(screen.queryByText('dashboard')).not.toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
});

it('renders the page for an allowed role', () => {
  renderGuarded({ token: 'tok', user: admin, initialised: true }, ['facility_admin']);
  expect(screen.getByText('secret content')).toBeInTheDocument();
});

it('redirects a role that is not permitted', () => {
  renderGuarded({ token: 'tok', user: employee, initialised: true }, ['facility_admin']);
  expect(screen.getByText('dashboard')).toBeInTheDocument();
  expect(screen.queryByText('secret content')).not.toBeInTheDocument();
});

it('admits any signed-in role when no roles are specified', () => {
  renderGuarded({ token: 'tok', user: employee, initialised: true });
  expect(screen.getByText('secret content')).toBeInTheDocument();
});

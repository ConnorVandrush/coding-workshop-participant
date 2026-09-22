/**
 * Integration test for the sign-in page.
 *
 * This drives the real store and the real thunk with only `fetch` stubbed, so
 * it covers the whole path a user takes: filling the form, dispatching the
 * login, storing the token, and surfacing a server error in the UI.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from './LoginPage';
import authReducer from '../store/authSlice';

/**
 * Stub fetch with one canned response.
 *
 * @param {number} status HTTP status to return.
 * @param {*} body Value serialised as the response body.
 * @returns {import('vitest').Mock} The stubbed fetch.
 */
function stubFetch(status, body) {
  const mock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/**
 * Render the login page against a real store.
 *
 * @returns {object} The created store, for asserting on resulting state.
 */
function renderLogin() {
  const store = configureStore({ reducer: { auth: authReducer } });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>dashboard</div>} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const session = {
  access_token: 'tok',
  token_type: 'bearer',
  expires_in: 43200,
  user: { id: 1, email: 'admin@acme.inc', full_name: 'Ada Admin', role: 'facility_admin', is_active: true },
};

describe('signing in', () => {
  it('posts the credentials and stores the returned session', async () => {
    const fetchMock = stubFetch(200, session);
    const store = renderLogin();

    await userEvent.type(screen.getByLabelText(/Work email/), 'admin@acme.inc');
    await userEvent.type(screen.getByLabelText(/Password/), 'Workshop#2026');
    await userEvent.click(screen.getByRole('button', { name: /Sign in/i }));

    await waitFor(() => expect(store.getState().auth.token).toBe('tok'));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/auth\/login$/);
    expect(JSON.parse(init.body)).toEqual({ email: 'admin@acme.inc', password: 'Workshop#2026' });
    expect(store.getState().auth.user.role).toBe('facility_admin');
  });

  it('navigates onward once authenticated', async () => {
    stubFetch(200, session);
    renderLogin();
    await userEvent.type(screen.getByLabelText(/Work email/), 'admin@acme.inc');
    await userEvent.type(screen.getByLabelText(/Password/), 'Workshop#2026');
    await userEvent.click(screen.getByRole('button', { name: /Sign in/i }));
    await waitFor(() => expect(screen.getByText('dashboard')).toBeInTheDocument());
  });

  it('shows the server message when the credentials are wrong', async () => {
    stubFetch(401, {
      error: { status: 401, type: 'invalid_credentials', message: 'Email or password is incorrect', details: null },
    });
    const store = renderLogin();

    await userEvent.type(screen.getByLabelText(/Work email/), 'admin@acme.inc');
    await userEvent.type(screen.getByLabelText(/Password/), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /Sign in/i }));

    expect(await screen.findByText('Email or password is incorrect')).toBeInTheDocument();
    expect(store.getState().auth.token).toBeNull();
  });
});

describe('registering', () => {
  it('flattens field validation errors from the API', async () => {
    stubFetch(400, {
      error: {
        status: 400,
        type: 'validation_error',
        message: 'Request payload failed validation',
        details: [{ field: 'body.email', message: 'email must belong to the @acme.inc domain' }],
      },
    });
    renderLogin();

    await userEvent.click(screen.getByRole('tab', { name: /Register/i }));
    await userEvent.type(screen.getByLabelText(/Full name/), 'Nope Person');
    await userEvent.type(screen.getByLabelText(/Work email/), 'someone@gmail.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'password123');
    await userEvent.click(screen.getByRole('button', { name: /Create account/i }));

    expect(
      await screen.findByText(/email: email must belong to the @acme.inc domain/),
    ).toBeInTheDocument();
  });

  it('reveals the full name field only on the register tab', async () => {
    renderLogin();
    expect(screen.queryByLabelText(/Full name/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Register/i }));
    expect(screen.getByLabelText(/Full name/)).toBeInTheDocument();
  });
});

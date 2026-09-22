/**
 * Tests for the application shell.
 *
 * The shell decides which navigation a persona sees and how it is presented:
 * a permanent sidebar on desktop, a drawer behind a hamburger below the
 * breakpoint. React Responsive is mocked so the breakpoint is deterministic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMediaQuery } from 'react-responsive';
import AppLayout from './AppLayout';
import { ADMIN, EMPLOYEE, ENGINEER, renderPage } from '../test/utils';

vi.mock('react-responsive', () => ({ useMediaQuery: vi.fn() }));

/**
 * Render the shell around a stub page.
 *
 * @param {object} user The signed-in persona.
 * @returns {object} The render result, including the store.
 */
const renderShell = (user) =>
  renderPage(<AppLayout><div>page content</div></AppLayout>, { user });

beforeEach(() => useMediaQuery.mockReturnValue(true));

describe('navigation', () => {
  it('shows the shared destinations to every persona', () => {
    renderShell(EMPLOYEE);
    ['Dashboard', 'Incidents', 'Facilities', 'Engineers'].forEach((label) => {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    });
  });

  it('shows Accounts to a facility admin only', () => {
    renderShell(ADMIN);
    expect(screen.getByRole('link', { name: 'Accounts' })).toBeInTheDocument();
  });

  it.each([['employee', EMPLOYEE], ['engineer', ENGINEER]])(
    'hides Accounts from an %s',
    (_name, user) => {
      renderShell(user);
      expect(screen.queryByRole('link', { name: 'Accounts' })).not.toBeInTheDocument();
    },
  );

  it('renders the routed page inside the shell', () => {
    renderShell(ADMIN);
    expect(screen.getByText('page content')).toBeInTheDocument();
  });
});

describe('identity', () => {
  it('shows the role and the initials of the signed-in user', () => {
    renderShell(ADMIN);
    expect(screen.getByText('Facility Admin')).toBeInTheDocument();
    expect(screen.getByText('AA')).toBeInTheDocument();
  });

  it('labels an engineer correctly', () => {
    renderShell(ENGINEER);
    expect(screen.getByText('Engineer')).toBeInTheDocument();
    expect(screen.getByText('SO')).toBeInTheDocument();
  });
});

describe('signing out', () => {
  it('clears the session', async () => {
    const { store } = renderShell(ADMIN);
    expect(store.getState().auth.token).toBe('test-token');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(store.getState().auth.token).toBeNull();
  });
});

describe('below the breakpoint', () => {
  beforeEach(() => useMediaQuery.mockReturnValue(false));

  it('replaces the sidebar with a hamburger', () => {
    renderShell(ADMIN);
    expect(screen.getByLabelText('Open navigation')).toBeInTheDocument();
    // The role chip is desktop-only; the avatar tooltip still carries identity.
    expect(screen.queryByText('Facility Admin')).not.toBeInTheDocument();
  });

  it('opens and closes the drawer through the store', async () => {
    const { store } = renderShell(ADMIN);
    expect(store.getState().ui.drawerOpen).toBe(false);

    await userEvent.click(screen.getByLabelText('Open navigation'));
    expect(store.getState().ui.drawerOpen).toBe(true);

    // Choosing a destination closes it again, so the page is not left covered.
    await userEvent.click(screen.getByRole('link', { name: 'Incidents' }));
    expect(store.getState().ui.drawerOpen).toBe(false);
  });

  it('shortens the title for a narrow app bar', () => {
    renderShell(ADMIN);
    expect(screen.queryByText('Facility Incident Management')).not.toBeInTheDocument();
    expect(screen.getAllByText('ACME Facilities').length).toBeGreaterThan(0);
  });
});

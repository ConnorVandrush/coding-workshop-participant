/**
 * Tests for the notification bell.
 *
 * The badge is how anyone knows the asynchronous fan-out happened at all, so
 * what matters is that it reflects the unread count, that opening an entry
 * both dismisses it and goes where it points, and that its accessible name
 * carries the count rather than leaving it to the badge alone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotificationBell from './NotificationBell';
import { mockApi, renderPage } from '../test/utils';

const notification = (id, overrides = {}) => ({
  id,
  incident_id: 42,
  event: 'status_changed',
  body: `#42 "Projector fault" moved to BLOCKED`,
  is_read: false,
  created_at: '2026-09-22T12:00:00Z',
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('the badge', () => {
  it('shows the unread count once the feed loads', async () => {
    mockApi({ 'GET /notifications': { unread: 3, items: [notification(1), notification(2)] } });
    renderPage(<NotificationBell />);
    expect(await screen.findByLabelText('Notifications, 3 unread')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('carries no count when everything is read', async () => {
    mockApi({ 'GET /notifications': { unread: 0, items: [notification(1, { is_read: true })] } });
    renderPage(<NotificationBell />);
    await waitFor(() => expect(screen.getByLabelText('Notifications')).toBeInTheDocument());
  });
});

describe('the feed', () => {
  it('lists what the worker wrote', async () => {
    mockApi({ 'GET /notifications': { unread: 1, items: [notification(1)] } });
    renderPage(<NotificationBell />);

    await userEvent.click(await screen.findByLabelText(/Notifications/));
    expect(await screen.findByText(/moved to BLOCKED/)).toBeInTheDocument();
  });

  it('explains an empty feed rather than showing a blank panel', async () => {
    mockApi({ 'GET /notifications': { unread: 0, items: [] } });
    renderPage(<NotificationBell />);

    await userEvent.click(await screen.findByLabelText(/Notifications/));
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
  });

  it('marks an entry read and follows it to the incident', async () => {
    const fetchMock = mockApi({
      'GET /notifications': { unread: 1, items: [notification(1)] },
      'POST /notifications/:id/read': notification(1, { is_read: true }),
    });
    renderPage(<NotificationBell />);

    await userEvent.click(await screen.findByLabelText(/Notifications/));
    await userEvent.click(await screen.findByText(/moved to BLOCKED/));

    await waitFor(() => {
      const read = fetchMock.mock.calls.find(([url, init]) =>
        init?.method === 'POST' && String(url).endsWith('/read'));
      expect(read).toBeDefined();
    });
    expect(await screen.findByText('incident detail page')).toBeInTheDocument();
  });

  it('does not re-mark something already read', async () => {
    const fetchMock = mockApi({
      'GET /notifications': { unread: 0, items: [notification(1, { is_read: true })] },
    });
    renderPage(<NotificationBell />);

    await userEvent.click(await screen.findByLabelText(/Notifications/));
    await userEvent.click(await screen.findByText(/moved to BLOCKED/));

    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('clears the whole feed on demand', async () => {
    const fetchMock = mockApi({
      'GET /notifications': { unread: 2, items: [notification(1), notification(2)] },
      'POST /notifications/read-all': { unread: 0, marked: 2 },
    });
    const { store } = renderPage(<NotificationBell />);

    await userEvent.click(await screen.findByLabelText(/Notifications/));
    await userEvent.click(await screen.findByRole('button', { name: /Mark all read/i }));

    await waitFor(() => expect(store.getState().notifications.unread).toBe(0));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/read-all'))).toBe(true);
  });

  it('offers no "mark all" control when nothing is unread', async () => {
    mockApi({ 'GET /notifications': { unread: 0, items: [notification(1, { is_read: true })] } });
    renderPage(<NotificationBell />);

    await userEvent.click(await screen.findByLabelText(/Notifications/));
    await screen.findByText(/moved to BLOCKED/);
    expect(screen.queryByRole('button', { name: /Mark all read/i })).not.toBeInTheDocument();
  });
});

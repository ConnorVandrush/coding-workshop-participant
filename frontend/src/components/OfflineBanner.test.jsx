/**
 * Tests for the offline banner.
 *
 * Installed as an app the shell opens with no network at all, so the banner is
 * what stops that looking like a broken application. It must appear and
 * disappear with the browser's own events, and must not cry wolf.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import OfflineBanner from './OfflineBanner';

/**
 * Pretend the browser is online or offline, and fire the matching event.
 *
 * @param {boolean} online Whether the browser should report itself online.
 */
function setOnline(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('while online', () => {
  it('renders nothing', () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays quiet when the browser cannot report connectivity', () => {
    // navigator.onLine is undefined in some environments. Claiming to be
    // offline there would be worse than missing a real outage.
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: undefined });
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('while offline', () => {
  it('explains that data will not update', () => {
    render(<OfflineBanner />);
    setOnline(false);
    expect(screen.getByRole('status')).toHaveTextContent(/You are offline/);
    expect(screen.getByRole('status')).toHaveTextContent(/nothing here will update/);
  });

  it('shows immediately when mounted already offline', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('disappears once the connection returns', () => {
    render(<OfflineBanner />);
    setOnline(false);
    expect(screen.getByRole('status')).toBeInTheDocument();

    setOnline(true);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

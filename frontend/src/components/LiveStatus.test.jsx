/**
 * Tests for the freshness indicator.
 *
 * Without this the polling is invisible, so what matters is that it reports
 * honestly: the age comes from when the data actually arrived, a refresh in
 * flight is visible, and the manual control cannot be double-fired.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveStatus from './LiveStatus';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('freshness', () => {
  it('reads as just now before the first tick', () => {
    render(<LiveStatus loading={false} onRefresh={() => {}} updatedAt={Date.now()} />);
    expect(screen.getByText('Updated just now')).toBeInTheDocument();
  });

  it('counts up in seconds', async () => {
    render(<LiveStatus loading={false} onRefresh={() => {}} updatedAt={Date.now() - 30_000} />);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await screen.findByText(/Updated 3[01]s ago/)).toBeInTheDocument();
  });

  it('switches to minutes once past a minute', async () => {
    render(<LiveStatus loading={false} onRefresh={() => {}} updatedAt={Date.now() - 125_000} />);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await screen.findByText('Updated 2 min ago')).toBeInTheDocument();
  });

  it('says just now when no timestamp is available yet', () => {
    render(<LiveStatus loading={false} onRefresh={() => {}} />);
    expect(screen.getByText('Updated just now')).toBeInTheDocument();
  });
});

describe('refreshing', () => {
  it('announces a refresh in flight', () => {
    render(<LiveStatus loading onRefresh={() => {}} updatedAt={Date.now()} />);
    expect(screen.getByText('Refreshing…')).toBeInTheDocument();
  });

  it('disables the manual control while a refresh is in flight', () => {
    render(<LiveStatus loading onRefresh={() => {}} label="incidents" />);
    expect(screen.getByLabelText('Refresh incidents')).toBeDisabled();
  });

  it('calls back when refreshed manually', async () => {
    const onRefresh = vi.fn();
    render(<LiveStatus loading={false} onRefresh={onRefresh} label="dashboard" />);
    await userEvent.click(screen.getByLabelText('Refresh dashboard'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('announces changes politely rather than interrupting', () => {
    // The text changes every second; an assertive region would make a screen
    // reader talk over whatever the user is doing.
    render(<LiveStatus loading={false} onRefresh={() => {}} />);
    expect(screen.getByText(/Updated/)).toHaveAttribute('aria-live', 'polite');
  });
});

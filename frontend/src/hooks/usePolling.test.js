/**
 * Tests for the polling hook.
 *
 * The behaviours that matter are the ones that stop it being wasteful or
 * disruptive: no requests while the tab is hidden, an immediate refresh when
 * the tab comes back, suspension while a write is in flight, and a stable
 * interval even as the callback identity changes on every render.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import usePolling from './usePolling';

/**
 * Pretend the tab is hidden or visible, and fire the event the browser would.
 *
 * @param {boolean} hidden Whether the document should report itself hidden.
 */
function setHidden(hidden) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('interval', () => {
  it('calls back once per interval', () => {
    const spy = vi.fn();
    renderHook(() => usePolling(spy, { intervalMs: 1000 }));

    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('stops when the component unmounts', () => {
    const spy = vi.fn();
    const { unmount } = renderHook(() => usePolling(spy, { intervalMs: 1000 }));
    vi.advanceTimersByTime(1000);
    unmount();
    vi.advanceTimersByTime(5000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps ticking when the callback identity changes every render', () => {
    // A new arrow function each render would otherwise restart the interval
    // before it ever fires, so polling would silently never happen.
    const spy = vi.fn();
    const { rerender } = renderHook(({ n }) => usePolling(() => spy(n), { intervalMs: 1000 }), {
      initialProps: { n: 1 },
    });
    vi.advanceTimersByTime(1000);
    rerender({ n: 2 });
    vi.advanceTimersByTime(1000);

    expect(spy).toHaveBeenCalledTimes(2);
    // ...and the latest callback is the one invoked.
    expect(spy).toHaveBeenLastCalledWith(2);
  });

  it('still fires when the component re-renders faster than the interval', () => {
    // This is the failure mode the ref exists to prevent: if the effect depended
    // on the callback, a component re-rendering every 300ms would restart the
    // timer before it ever reached 1000ms, and polling would silently never
    // happen. Re-rendering at the interval boundary does not expose it.
    const spy = vi.fn();
    const { rerender } = renderHook(({ n }) => usePolling(() => spy(n), { intervalMs: 1000 }), {
      initialProps: { n: 0 },
    });

    for (let i = 1; i <= 5; i += 1) {
      vi.advanceTimersByTime(300);
      rerender({ n: i });
    }

    expect(spy).toHaveBeenCalled();
  });
});

describe('tab visibility', () => {
  it('does not poll a hidden tab', () => {
    const spy = vi.fn();
    renderHook(() => usePolling(spy, { intervalMs: 1000 }));

    setHidden(true);
    spy.mockClear();
    vi.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes immediately when the tab becomes visible again', () => {
    // Otherwise someone returning to the tab stares at data that could be a
    // whole interval out of date.
    const spy = vi.fn();
    renderHook(() => usePolling(spy, { intervalMs: 60000 }));

    setHidden(true);
    spy.mockClear();
    setHidden(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resumes the interval after becoming visible', () => {
    const spy = vi.fn();
    renderHook(() => usePolling(spy, { intervalMs: 1000 }));
    setHidden(true);
    vi.advanceTimersByTime(3000);
    setHidden(false);
    spy.mockClear();
    vi.advanceTimersByTime(2000);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('suspension', () => {
  it('does nothing while disabled', () => {
    const spy = vi.fn();
    renderHook(() => usePolling(spy, { intervalMs: 1000, enabled: false }));
    vi.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('starts once it becomes enabled', () => {
    const spy = vi.fn();
    const { rerender } = renderHook(({ enabled }) => usePolling(spy, { intervalMs: 1000, enabled }), {
      initialProps: { enabled: false },
    });
    vi.advanceTimersByTime(2000);
    expect(spy).not.toHaveBeenCalled();

    rerender({ enabled: true });
    vi.advanceTimersByTime(2000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it.each([[0], [-1], [Number.NaN]])('ignores a nonsensical interval (%s)', (intervalMs) => {
    const spy = vi.fn();
    renderHook(() => usePolling(spy, { intervalMs }));
    vi.advanceTimersByTime(10000);
    expect(spy).not.toHaveBeenCalled();
  });
});

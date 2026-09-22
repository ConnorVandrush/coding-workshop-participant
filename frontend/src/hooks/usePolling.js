/**
 * Refresh data on an interval while the page is being looked at.
 *
 * This is the real-time mechanism the architecture allows. Lambda Function URLs
 * do not support the WebSocket upgrade, and every managed alternative - API
 * Gateway WebSockets, AppSync, IoT Core - is outside the permissions this
 * deployment has, so a persistent connection is not available. For an incident
 * dashboard, a short poll is a reasonable substitute: it needs no
 * infrastructure, behaves identically against LocalStack and AWS, and degrades
 * to "slightly stale" rather than to a broken connection.
 *
 * Two behaviours keep it from being wasteful. Nothing is requested while the
 * tab is hidden, and returning to the tab refreshes immediately rather than
 * waiting out the remainder of an interval, so a user who switches back never
 * looks at data that is a whole cycle old.
 */

import { useEffect, useRef } from 'react';

/** Interval between refreshes, overridable per deployment. */
export const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS ?? 20000);

/**
 * Call `callback` periodically while the document is visible.
 *
 * @param {Function} callback Invoked on each tick; typically dispatches a fetch.
 * @param {object} [options] Options.
 * @param {number} [options.intervalMs] Milliseconds between ticks.
 * @param {boolean} [options.enabled] Set false to suspend polling, for example
 *   while a write is in flight, so a refresh cannot race the response.
 */
export default function usePolling(callback, { intervalMs = POLL_INTERVAL_MS, enabled = true } = {}) {
  // Held in a ref so that a new callback identity on every render does not
  // restart the interval, which would stop it ever firing.
  const saved = useRef(callback);

  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || !Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;

    const run = () => {
      if (!document.hidden) saved.current();
    };

    const timer = setInterval(run, intervalMs);
    // Refresh straight away when the tab is brought back into view.
    document.addEventListener('visibilitychange', run);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [enabled, intervalMs]);
}

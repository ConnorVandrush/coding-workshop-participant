/**
 * Vitest setup, loaded before every test file.
 *
 * Adds the jest-dom matchers and supplies the browser APIs jsdom does not
 * implement but Material UI and React Responsive expect to exist.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount anything a test rendered, so one test cannot leak DOM into the next.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom has no matchMedia. React Responsive and MUI both call it, and MUI's
// useMediaQuery throws without it. Components whose behaviour depends on the
// breakpoint mock `react-responsive` directly rather than relying on this.
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// Used by confirm-before-delete flows; default to confirming so those paths run.
window.confirm = vi.fn(() => true);

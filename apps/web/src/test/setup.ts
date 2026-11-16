import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, vi } from 'vitest';
import '../lib/i18n';
import { setAccessToken } from '../lib/session';

// Lazy routes and 1 s polling can exceed the 1 s default on a busy machine (seen once in CI-like load).
configure({ asyncUtilTimeout: 5000 });

// jsdom has no canvas or ResizeObserver. Chart options are unit-tested as pure functions
// (src/charts); in component tests a chart is a labelled placeholder.
vi.mock('../components/EChart', () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) =>
    createElement('div', { role: 'img', 'aria-label': ariaLabel }),
  cssToken: (_name: string, fallback: string) => fallback,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setAccessToken(null);
  document.cookie = 'ci_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

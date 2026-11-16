import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import '../lib/i18n';
import { setAccessToken } from '../lib/session';

// Lazy routes and 1 s polling can exceed the 1 s default on a busy machine (seen once in CI-like load).
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setAccessToken(null);
  document.cookie = 'ci_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

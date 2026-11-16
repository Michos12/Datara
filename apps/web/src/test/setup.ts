import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import '../lib/i18n';
import { setAccessToken } from '../lib/session';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setAccessToken(null);
  document.cookie = 'ci_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

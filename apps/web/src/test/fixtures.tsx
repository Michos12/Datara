import { INDUSTRY_PRESETS, type Role, type Session } from '@ci/contracts';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { AppProviders, createQueryClient } from '../app/providers';
import { routes } from '../app/routes';
import type { AuthState } from '../features/auth/AuthProvider';

export function makeSession(role: Role = 'OWNER'): Session {
  const organizationId = '0193a2b4-0000-7000-8000-000000000001';
  return {
    user: {
      id: '0193a2b4-0000-7000-8000-0000000000aa',
      email: 'ana@example.com',
      fullName: 'Ana Pérez',
    },
    organization: {
      id: organizationId,
      name: 'Café Central',
      slug: 'cafe-central-1a2b3c4d',
      timezone: 'America/Bogota',
      currency: 'COP',
      industry: 'restaurant',
      settings: INDUSTRY_PRESETS.restaurant,
      createdAt: '2026-11-16T00:00:00.000Z',
    },
    role,
    memberships: [{ organizationId, organizationName: 'Café Central', role }],
  };
}

type Handler = (init: RequestInit | undefined) => { status: number; body?: unknown };

/** Routes fetch calls by "METHOD /path" (path relative to /api/v1). Unmatched calls fail loudly. */
export function mockApi(handlers: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${url.pathname.replace('/api/v1', '')}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`Unexpected request: ${key}`);
    const { status, body } = handler(init);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const READY = {
  'GET /ready': () => ({
    status: 200,
    body: { status: 'ready', checks: { database: 'up', migrations: 'up', analytics: 'up' } },
  }),
};

export function renderApp(path: string, auth: AuthState) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const utils = render(
    <AppProviders client={createQueryClient()} initialAuth={auth}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...utils, router };
}

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from './providers';
import { routes } from './routes';

function mockReady(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('AppShell', () => {
  it('renders the main navigation with the active page marked', async () => {
    mockReady(200, {
      status: 'ready',
      checks: { database: 'up', migrations: 'up', analytics: 'up' },
    });
    renderAt('/customers');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Customers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { name: 'Customers' })).toBeInTheDocument();
    expect(screen.getByText('Planned for M2')).toBeInTheDocument();
  });

  it('shows healthy status when all services are up', async () => {
    mockReady(200, {
      status: 'ready',
      checks: { database: 'up', migrations: 'up', analytics: 'up' },
    });
    renderAt('/settings');
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
  });

  it('warns when analytics is down but the API is ready', async () => {
    mockReady(200, {
      status: 'ready',
      checks: { database: 'up', migrations: 'up', analytics: 'down' },
    });
    renderAt('/settings');
    expect(await screen.findByText('Analytics unavailable')).toBeInTheDocument();
  });

  it('treats 503 from /ready as "not ready", not as a crash', async () => {
    mockReady(503, {
      status: 'not_ready',
      checks: { database: 'down', migrations: 'down', analytics: 'up' },
    });
    renderAt('/settings');
    expect(await screen.findByText('API not ready')).toBeInTheDocument();
  });

  it('renders a not-found page for unknown routes', () => {
    mockReady(200, {
      status: 'ready',
      checks: { database: 'up', migrations: 'up', analytics: 'up' },
    });
    renderAt('/does-not-exist');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

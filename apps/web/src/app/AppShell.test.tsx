import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeSession, mockApi, READY, renderApp } from '../test/fixtures';

const signedIn = { status: 'authenticated' as const, session: makeSession() };

describe('AppShell', () => {
  it('renders the main navigation with the active page marked', async () => {
    mockApi(READY);
    renderApp('/team', signedIn);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Team' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('heading', { name: 'Team' })).toBeInTheDocument();
  });

  it('shows the user, organization and role', () => {
    mockApi(READY);
    renderApp('/team', signedIn);
    expect(screen.getByText('Ana Pérez')).toBeInTheDocument();
    expect(screen.getByText('Café Central · Owner')).toBeInTheDocument();
  });

  it('shows healthy status when all services are up', async () => {
    mockApi(READY);
    renderApp('/team', signedIn);
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
  });

  it('warns when analytics is down but the API is ready', async () => {
    mockApi({
      'GET /ready': () => ({
        status: 200,
        body: { status: 'ready', checks: { database: 'up', migrations: 'up', analytics: 'down' } },
      }),
    });
    renderApp('/team', signedIn);
    expect(await screen.findByText('Analytics unavailable')).toBeInTheDocument();
  });

  it('treats 503 from /ready as "not ready", not as a crash', async () => {
    mockApi({
      'GET /ready': () => ({
        status: 503,
        body: {
          status: 'not_ready',
          checks: { database: 'down', migrations: 'down', analytics: 'up' },
        },
      }),
    });
    renderApp('/team', signedIn);
    expect(await screen.findByText('API not ready')).toBeInTheDocument();
  });

  it('renders a not-found page for unknown routes', () => {
    mockApi(READY);
    renderApp('/does-not-exist', signedIn);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

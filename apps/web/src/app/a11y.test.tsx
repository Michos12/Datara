import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axeViolations } from '../test/axe';
import { makeSession, mockApi, READY, renderApp } from '../test/fixtures';

const anonymous = { status: 'anonymous' as const };
const owner = { status: 'authenticated' as const, session: makeSession('OWNER') };

/** WCAG 2.1 AA (axe-core) on pages not covered by their own feature tests. */
describe('accessibility', () => {
  it('actually detects violations (guards against a silently disabled check)', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<img src="x.png"><input type="text">';
    document.body.appendChild(host);
    const found = await axeViolations(host);
    host.remove();
    expect(found.some((v) => v.startsWith('image-alt'))).toBe(true);
    expect(found.some((v) => v.startsWith('label'))).toBe(true);
  });

  it.each([
    ['/login', 'Sign in to Customer Insights'],
    ['/signup', 'Create your workspace'],
    ['/forgot-password', 'Reset your password'],
  ])('%s has no violations', async (path, heading) => {
    mockApi(READY);
    renderApp(path, anonymous);
    await screen.findByRole('heading', { name: heading });
    expect(await axeViolations()).toEqual([]);
  });

  it('settings has no violations', async () => {
    mockApi(READY);
    renderApp('/settings', owner);
    await screen.findByRole('heading', { name: 'Settings' });
    expect(await axeViolations()).toEqual([]);
  });

  it('customers (empty) has no violations', async () => {
    mockApi({
      ...READY,
      'GET /customers': () => ({
        status: 200,
        body: { data: [], page: { nextCursor: null, limit: 50 } },
      }),
      'GET /segments/config': () => ({ status: 404 }),
    });
    renderApp('/customers', owner);
    await screen.findByText('No customers yet');
    expect(await axeViolations()).toEqual([]);
  });

  it('imports has no violations', async () => {
    mockApi({ ...READY, 'GET /imports': () => ({ status: 200, body: { data: [] } }) });
    renderApp('/imports', owner);
    await screen.findByRole('heading', { name: 'Imports' });
    expect(await axeViolations()).toEqual([]);
  });
});

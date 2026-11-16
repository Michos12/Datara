import type { Customer } from '@ci/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: '0193a2b4-0000-7000-8000-00000000c001',
    externalId: 'C-1',
    firstName: 'Ana',
    lastName: 'Pérez',
    email: 'ana@example.com',
    phone: null,
    country: 'CO',
    region: null,
    city: 'Medellín',
    registeredAt: '2025-03-02',
    tags: ['vip'],
    marketingConsent: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    stats: {
      orderCount: 3,
      totalNetCents: 1_200_000,
      aovCents: 400_000,
      firstOrderAt: '2026-01-05T15:00:00.000Z',
      lastOrderAt: '2026-10-01T15:00:00.000Z',
      daysSinceLastOrder: 45,
    },
    segment: { key: 'loyal', rScore: 4, fScore: 3, mScore: 5, lifecycleStatus: 'ACTIVE' },
    ...overrides,
  };
}

const page = (data: Customer[]) => ({
  status: 200,
  body: { data, page: { nextCursor: null, limit: 50 } },
});
const owner = { status: 'authenticated' as const, session: makeSession('OWNER') };

describe('CustomersPage', () => {
  it('lists customers with spend in the organization currency', async () => {
    mockApi({ ...READY, 'GET /customers': () => page([customer()]) });
    renderApp('/customers', owner);
    const row = (await screen.findByRole('link', { name: 'Ana Pérez' })).closest('tr')!;
    expect(within(row).getByText('3')).toBeInTheDocument();
    // COP has two ISO minor units: 1,200,000 centavos = 12,000 pesos.
    expect(within(row).getByText(/12,000/)).toBeInTheDocument();
  });

  it('offers import and demo data when the organization is empty', async () => {
    mockApi({ ...READY, 'GET /customers': () => page([]) });
    renderApp('/customers', owner);
    expect(await screen.findByText('No customers yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Import data' }).length).toBeGreaterThan(0);
  });

  it('hides write actions from viewers', async () => {
    mockApi({ ...READY, 'GET /customers': () => page([]) });
    renderApp('/customers', { status: 'authenticated', session: makeSession('VIEWER') });
    await screen.findByText('No customers yet');
    expect(screen.queryByRole('button', { name: 'New customer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load demo data' })).not.toBeInTheDocument();
  });

  it('sends search and sort to the API', async () => {
    const urls: string[] = [];
    const fetchMock = mockApi({ ...READY, 'GET /customers': () => page([]) });
    renderApp('/customers', owner);
    await screen.findByText('No customers yet');
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), '-total_spent');
    await userEvent.type(screen.getByLabelText('Search name, email or ID'), 'ana');
    await screen.findByText('No customers match these filters.');
    for (const [url] of fetchMock.mock.calls) urls.push(String(url));
    expect(urls.some((u) => u.includes('sort=-total_spent') && u.includes('q=ana'))).toBe(true);
  });
});

describe('CustomerProfilePage', () => {
  it('shows purchase statistics and order history', async () => {
    const c = customer();
    mockApi({
      ...READY,
      [`GET /customers/${c.id}`]: () => ({ status: 200, body: c }),
      [`GET /customers/${c.id}/orders`]: () => ({
        status: 200,
        body: {
          data: [
            {
              id: '0193a2b4-0000-7000-8000-00000000d001',
              externalId: 'O-1',
              customerId: c.id,
              orderedAt: '2026-10-01T15:00:00.000Z',
              status: 'partially_refunded',
              channel: 'online',
              grossCents: 500_000,
              discountCents: 0,
              taxCents: 0,
              refundedCents: 100_000,
              netCents: 400_000,
              createdAt: '2026-10-01T15:00:00.000Z',
            },
          ],
          page: { nextCursor: null, limit: 25 },
        },
      }),
    });
    renderApp(`/customers/${c.id}`, owner);
    expect(await screen.findByRole('heading', { name: 'Ana Pérez' })).toBeInTheDocument();
    expect(screen.getByText('45 days ago')).toBeInTheDocument();
    expect(await screen.findByText('Partially refunded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add order' })).toBeInTheDocument();
  });

  it('shows a not-found state for unknown customers', async () => {
    mockApi({
      ...READY,
      'GET /customers/0193a2b4-0000-7000-8000-00000000ffff': () => ({
        status: 404,
        body: { type: '/problems/not-found', title: 'Not found', status: 404, code: 'NOT_FOUND' },
      }),
      'GET /customers/0193a2b4-0000-7000-8000-00000000ffff/orders': () => ({
        status: 404,
        body: { type: '/problems/not-found', title: 'Not found', status: 404, code: 'NOT_FOUND' },
      }),
    });
    renderApp('/customers/0193a2b4-0000-7000-8000-00000000ffff', owner);
    expect(await screen.findByRole('heading', { name: 'Customer not found' })).toBeInTheDocument();
  });
});

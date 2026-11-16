import { DEFAULT_SEGMENT_CONFIG } from '@ci/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';

function meta(metric: string, warnings: { code: string; message: string }[] = []) {
  return {
    metric,
    definitionVersions: {},
    kind: 'measured',
    period: { start: '2026-09-01', end: '2026-11-01', grain: 'month' },
    comparePeriod: null,
    asOf: '2026-10-31',
    today: '2026-11-16',
    timezone: 'America/Bogota',
    currency: 'COP',
    settings: {},
    computedAt: '2026-11-16T12:00:00Z',
    dataVersion: 3,
    warnings,
  };
}

const grain = { grain: 'month', medianGapDays: 21 };

const retention = {
  meta: meta('retention_rate', [{ code: 'LOW_SAMPLE', message: 'Some rates are small.' }]),
  data: {
    series: [
      {
        period: '2026-09-01',
        end: '2026-10-01',
        partial: false,
        base: 200,
        retained: 82,
        rate: 0.41,
        low: 0.34,
        high: 0.48,
        lowSample: false,
      },
      {
        period: '2026-10-01',
        end: '2026-11-01',
        partial: false,
        base: 12,
        retained: 3,
        rate: 0.25,
        low: 0.09,
        high: 0.53,
        lowSample: true,
      },
    ],
    recommendedGrain: grain,
  },
};

const churn = {
  meta: meta('churn_rate'),
  data: {
    series: [
      {
        period: '2026-09-01',
        end: '2026-10-01',
        partial: false,
        base: 500,
        churned: 20,
        reactivated: 4,
        rate: 0.04,
        low: 0.026,
        high: 0.061,
        lowSample: false,
      },
      {
        period: '2026-10-01',
        end: '2026-11-01',
        partial: false,
        base: 490,
        churned: 25,
        reactivated: 2,
        rate: 0.051,
        low: 0.035,
        high: 0.074,
        lowSample: false,
      },
    ],
    bySegment: [
      {
        segment: 'champions',
        base: 120,
        churned: 2,
        rate: 0.0167,
        low: 0.005,
        high: 0.06,
        lowSample: false,
      },
      { segment: null, base: 10, churned: 1, rate: 0.1, low: 0.02, high: 0.4, lowSample: true },
    ],
    segmentAsOf: '2026-08-31',
    totals: { churned: 45, reactivated: 6 },
    churnDays: 180,
    recommendedGrain: grain,
  },
};

const churnedCustomers = {
  meta: meta('churn_rate'),
  data: [
    {
      customerId: '0193a2b4-0000-7000-8000-0000000000c1',
      firstName: 'Lucía',
      lastName: 'Gómez',
      email: 'lucia@example.com',
      externalId: 'C-1',
      lastPurchase: '2026-03-20',
      churnDate: '2026-09-16',
      orders: 7,
      netCents: 125000000,
      segment: 'lost',
    },
  ],
  page: { nextCursor: null, limit: 25, total: 1 },
};

const cohorts = {
  meta: meta('cohort_retention', [{ code: 'LOW_SAMPLE', message: 'Small cohorts are marked.' }]),
  data: {
    periods: [0, 1, 2],
    cohorts: [
      {
        cohort: '2026-08',
        size: 120,
        lowSample: false,
        active: [120, 42, 30],
        retention: [1, 0.35, 0.25],
        revenuePerCustomer: [5000000, 1500000, 1000000],
        cumulativeRevenuePerCustomer: [5000000, 6500000, 7500000],
      },
      {
        cohort: '2026-10',
        size: 12,
        lowSample: true,
        active: [12, null, null],
        retention: [1, null, null],
        revenuePerCustomer: [4000000, null, null],
        cumulativeRevenuePerCustomer: [4000000, null, null],
      },
    ],
    average: {
      size: 132,
      retention: [1, 0.35, 0.25],
      revenuePerCustomer: [4909091, 1500000, 1000000],
      cumulativeRevenuePerCustomer: [4909091, 6500000, 7500000],
    },
  },
};

const config = {
  id: '0193a2b4-0000-7000-8000-00000000f001',
  version: 1,
  isActive: true,
  config: DEFAULT_SEGMENT_CONFIG,
  createdAt: '2026-11-16T00:00:00.000Z',
};

const base = {
  ...READY,
  'GET /segments/config': () => ({ status: 200, body: config }),
  'GET /analytics/retention': () => ({ status: 200, body: retention }),
  'GET /analytics/churn': () => ({ status: 200, body: churn }),
  'GET /analytics/churn/customers': () => ({ status: 200, body: churnedCustomers }),
  'GET /analytics/cohorts': () => ({ status: 200, body: cohorts }),
};

describe('BehaviorPage', () => {
  it('shows retention with its confidence band, grain hint and table', async () => {
    mockApi(base);
    renderApp('/analytics', { status: 'authenticated', session: makeSession('VIEWER') });
    expect(await screen.findByRole('img', { name: 'Retention rate' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Retention' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/typically buy every 21 days, so month periods/)).toBeInTheDocument();
    expect(screen.getByText('Some rates are small.')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Retention rate' });
    const october = within(table).getByRole('row', { name: /Oct 26/ });
    expect(within(october).getByText(/25\.0\s?%/)).toBeInTheDocument();
    expect(within(october).getByTitle(/Fewer than 30 customers/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
  });

  it('explains churn, breaks it down by segment and lists churned customers', async () => {
    mockApi(base);
    renderApp('/analytics?tab=churn', { status: 'authenticated', session: makeSession('ANALYST') });
    expect(await screen.findByText(/Churn rate is not 1 − retention rate/)).toBeInTheDocument();
    expect(await screen.findByText('45')).toBeInTheDocument();
    expect(screen.getByText('180 days')).toBeInTheDocument();
    const segments = screen.getByRole('row', { name: /Champions/ });
    expect(within(segments).getByText('120')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Not scored/ })).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'Lucía Gómez' });
    expect(link).toHaveAttribute('href', '/customers/0193a2b4-0000-7000-8000-0000000000c1');
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });

  it('hides the churned-customer list from viewers', async () => {
    const fetchMock = mockApi(base);
    renderApp('/analytics?tab=churn', { status: 'authenticated', session: makeSession('VIEWER') });
    await screen.findByText(/Churn rate is not 1 − retention rate/);
    expect(screen.queryByText('Churned customers')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/churn/customers'))).toBe(false);
  });

  it('shows cohorts with incomplete months as not yet available and switches metrics', async () => {
    mockApi(base);
    renderApp('/analytics?tab=cohorts', { status: 'authenticated', session: makeSession('OWNER') });
    const august = await screen.findByRole('row', { name: /Aug 2026/ });
    expect(within(august).getByText('35%')).toBeInTheDocument();
    const october = screen.getByRole('row', { name: /Oct 2026/ });
    expect(within(october).getAllByText('Not yet available')).toHaveLength(2);
    expect(within(october).getByText('Fewer than 30 customers')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Weighted average/ })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Show'), 'cumulativeRevenuePerCustomer');
    expect(
      within(screen.getByRole('row', { name: /Aug 2026/ })).getByText(/75,000/),
    ).toBeInTheDocument();
  });

  it('sends the segment and grain filters', async () => {
    const fetchMock = mockApi(base);
    renderApp('/analytics', { status: 'authenticated', session: makeSession('OWNER') });
    await screen.findByRole('img', { name: 'Retention rate' });
    await userEvent.selectOptions(screen.getByLabelText('Segment'), 'champions');
    await userEvent.selectOptions(screen.getByLabelText('Compare by'), 'quarter');
    await screen.findByRole('img', { name: 'Retention rate' });
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('segment=champions') && u.includes('grain=quarter'))).toBe(
      true,
    );
  });

  it('explains when a segment filter needs a first snapshot', async () => {
    mockApi({
      ...base,
      'GET /analytics/retention': () => ({
        status: 409,
        body: {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          code: 'CONFLICT',
          detail: 'x',
        },
      }),
    });
    renderApp('/analytics', { status: 'authenticated', session: makeSession('OWNER') });
    expect(
      await screen.findByText(/Segment filters work after the first analytics run/),
    ).toBeInTheDocument();
  });
});

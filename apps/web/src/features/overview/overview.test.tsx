import type { OverviewResponse } from '@ci/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';
import { formatChange, formatKpiValue } from './KpiCard';
import { addDays, lastDay, resolvePreset, todayIn } from './periods';

describe('period presets', () => {
  const today = '2026-11-16';

  it('resolves half-open ranges in local dates', () => {
    expect(resolvePreset('last_month', today)).toEqual({ start: '2026-10-01', end: '2026-11-01' });
    expect(resolvePreset('this_month', today)).toEqual({ start: '2026-11-01', end: '2026-11-17' });
    expect(resolvePreset('last_3_months', today)).toEqual({
      start: '2026-08-01',
      end: '2026-11-01',
    });
    expect(resolvePreset('last_12_months', today)).toEqual({
      start: '2025-11-01',
      end: '2026-11-01',
    });
    expect(resolvePreset('year_to_date', today)).toEqual({
      start: '2026-01-01',
      end: '2026-11-17',
    });
  });

  it('crosses year boundaries', () => {
    expect(resolvePreset('last_month', '2026-01-05')).toEqual({
      start: '2025-12-01',
      end: '2026-01-01',
    });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(lastDay({ start: '2026-03-01', end: '2026-04-01' })).toBe('2026-03-31');
  });

  it('uses the organization time zone for "today"', () => {
    const lateUtc = new Date('2026-04-01T03:30:00Z'); // 22:30 on 31 March in Bogotá
    expect(todayIn('America/Bogota', lateUtc)).toBe('2026-03-31');
    expect(todayIn('Europe/Madrid', lateUtc)).toBe('2026-04-01');
  });
});

describe('KPI formatting', () => {
  it('formats by unit', () => {
    expect(formatKpiValue({ unit: 'ratio', value: 0.4123 }, 'USD')).toMatch(/41\.2\s?%/);
    expect(formatKpiValue({ unit: 'money', value: 123456.4 }, 'USD')).toMatch(/1,234\.56/);
    expect(formatKpiValue({ unit: 'count', value: null }, 'USD')).toBe('—');
  });

  it('shows rate changes in points and others as percentages', () => {
    expect(formatChange({ change: -0.018, changeType: 'points' })).toBe('−1.8 pts');
    expect(formatChange({ change: 0.25, changeType: 'relative' })).toBe('+25.0%');
    expect(formatChange({ change: null, changeType: 'relative' })).toBeNull();
  });
});

function overview(overrides: Partial<OverviewResponse['data']> = {}): OverviewResponse {
  return {
    meta: {
      metric: 'overview',
      definitionVersions: { revenue_net: 1 },
      kind: 'measured',
      period: { start: '2026-10-01', end: '2026-11-01', grain: 'day' },
      comparePeriod: { start: '2026-09-01', end: '2026-10-01' },
      asOf: '2026-10-31',
      today: '2026-11-16',
      timezone: 'America/Bogota',
      currency: 'COP',
      settings: {},
      computedAt: '2026-11-16T10:00:00Z',
      dataVersion: 3,
      warnings: [],
    },
    data: {
      kpis: [
        {
          key: 'total_customers',
          value: 2000,
          previous: 1900,
          change: 0.0526,
          changeType: 'relative',
          unit: 'count',
          kind: 'measured',
        },
        {
          key: 'retention_rate',
          value: 0.41,
          previous: 0.43,
          change: -0.02,
          changeType: 'points',
          unit: 'ratio',
          kind: 'measured',
          numerator: 41,
          denominator: 100,
        },
        {
          key: 'churn_rate',
          value: 0.05,
          previous: 0.04,
          change: 0.01,
          changeType: 'points',
          unit: 'ratio',
          kind: 'measured',
          numerator: 5,
          denominator: 20,
          warning: 'LOW_SAMPLE',
        },
        {
          key: 'orders',
          value: 300,
          previous: 280,
          change: 0.07,
          changeType: 'relative',
          unit: 'count',
          kind: 'measured',
        },
      ],
      trend: [
        {
          period: '2026-10-01',
          end: '2026-10-02',
          revenueNet: 100000,
          orders: 3,
          aov: 33333,
          buyers: 3,
          newCustomers: 1,
          returningCustomers: 2,
          partial: false,
        },
      ],
      guestRevenueShare: 0.05,
      historicalClvMedian: 1000,
      ...overrides,
    },
  };
}

const definitions = {
  data: [
    {
      key: 'churn_rate',
      name: 'Churn rate',
      version: 1,
      kind: 'measured',
      unit: 'ratio',
      formula: 'Customers alive at the period start whose churn date falls in the period.',
      period_rule: 'Churn lags inactivity.',
      description: 'Customers who crossed your inactivity threshold.',
    },
  ],
};

const status = {
  latestRun: null,
  stale: true,
  pending: null,
  nextRunAt: null,
  dataVersion: 3,
  dataQuality: null,
};

describe('OverviewPage', () => {
  it('shows KPIs with comparisons, sample warnings and definitions', async () => {
    mockApi({
      ...READY,
      'GET /analytics/overview': () => ({ status: 200, body: overview() }),
      'GET /analytics/status': () => ({ status: 200, body: status }),
      'GET /analytics/definitions': () => ({ status: 200, body: definitions }),
    });
    renderApp('/', { status: 'authenticated', session: makeSession('OWNER') });

    const churn = await screen.findByRole('region', { name: 'Churn rate' });
    expect(within(churn).getByText(/5\.0\s?%/)).toBeInTheDocument();
    // Churn going up is bad news, retention going down too.
    expect(within(churn).getByText(/\+1\.0 pts/)).toHaveClass('text-negative');
    expect(within(churn).getByText('Small sample')).toBeInTheDocument();
    expect(within(churn).getByText('5 / 20')).toBeInTheDocument();

    await userEvent.click(
      within(churn).getByRole('button', { name: 'How Churn rate is calculated' }),
    );
    expect(within(churn).getByRole('note')).toHaveTextContent(
      'Customers who crossed your inactivity threshold.',
    );

    const total = screen.getByRole('region', { name: 'Total customers' });
    expect(within(total).getByText(/\+5\.3%/)).toHaveClass('text-positive');
    expect(screen.getByText(/Data through/)).toHaveTextContent('America/Bogota');
  });

  it('requests the chosen period and comparison', async () => {
    const fetchMock = mockApi({
      ...READY,
      'GET /analytics/overview': () => ({ status: 200, body: overview() }),
      'GET /analytics/status': () => ({ status: 200, body: status }),
      'GET /analytics/definitions': () => ({ status: 200, body: definitions }),
    });
    renderApp('/', { status: 'authenticated', session: makeSession('OWNER') });
    await screen.findByRole('region', { name: 'Total customers' });
    await userEvent.selectOptions(screen.getByLabelText('Compare with'), 'previous_year');
    await userEvent.selectOptions(screen.getByLabelText('Period'), 'last_12_months');
    await screen.findByRole('region', { name: 'Total customers' });
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(
      urls.some((u) => u.includes('compare=previous_year') && /start=\d{4}-\d{2}-01/.test(u)),
    ).toBe(true);
  });

  it('shows an empty state for organizations without data', async () => {
    mockApi({
      ...READY,
      'GET /analytics/overview': () => ({
        status: 200,
        body: overview({
          kpis: [
            {
              key: 'total_customers',
              value: 0,
              previous: 0,
              change: null,
              changeType: 'relative',
              unit: 'count',
              kind: 'measured',
            },
            {
              key: 'orders',
              value: 0,
              previous: 0,
              change: null,
              changeType: 'relative',
              unit: 'count',
              kind: 'measured',
            },
          ],
        }),
      }),
      'GET /analytics/status': () => ({ status: 200, body: status }),
      'GET /analytics/definitions': () => ({ status: 200, body: definitions }),
    });
    renderApp('/', { status: 'authenticated', session: makeSession('OWNER') });
    expect(await screen.findByText('No data yet')).toBeInTheDocument();
  });

  it('explains when the analytics service is down', async () => {
    mockApi({
      ...READY,
      'GET /analytics/overview': () => ({
        status: 503,
        body: {
          type: '/problems/analytics-unavailable',
          title: 'Down',
          status: 503,
          code: 'ANALYTICS_UNAVAILABLE',
        },
      }),
      'GET /analytics/status': () => ({ status: 200, body: status }),
      'GET /analytics/definitions': () => ({ status: 200, body: definitions }),
    });
    renderApp('/', { status: 'authenticated', session: makeSession('OWNER') });
    expect(await screen.findByText(/analytics service is not available/)).toBeInTheDocument();
  });
});

import { DEFAULT_ENGAGEMENT_WEIGHTS, DEFAULT_SEGMENT_CONFIG } from '@ci/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axeViolations } from '../../test/axe';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';
import { lastMonths } from '../behavior/BehaviorPage';
import { todayIn } from '../overview/periods';

function meta(metric: string, warnings: { code: string; message: string }[] = []) {
  return {
    metric,
    definitionVersions: {},
    kind: 'measured',
    period: { start: '2025-11-01', end: '2026-11-01', grain: 'month' },
    comparePeriod: null,
    asOf: '2026-11-16',
    today: '2026-11-16',
    timezone: 'America/Bogota',
    currency: 'COP',
    settings: {},
    computedAt: '2026-11-16T12:00:00Z',
    dataVersion: 3,
    warnings,
  };
}

const rate = (r: number, lowSample = false) => ({
  rate: r,
  low: r - 0.05,
  high: r + 0.05,
  lowSample,
});
const counts = Object.fromEntries(Object.keys(DEFAULT_ENGAGEMENT_WEIGHTS).map((k) => [k, 0]));

const frequency = {
  meta: meta('repeat_purchase_rate', [
    { code: 'CENSORED', message: 'Recent customers may still come back.' },
  ]),
  data: {
    customers: 400,
    orderCounts: [
      { bucket: '1', min: 1, max: 1, count: 240 },
      { bucket: '2', min: 2, max: 2, count: 100 },
      { bucket: '11+', min: 11, max: null, count: 60 },
    ],
    repeat: { customers: 400, repeated: 160, ...rate(0.4) },
    averagePurchases: 2.35,
    gaps: { count: 500, p25: 12, median: 24, p75: 51, mean: 33, histogram: [] },
    timeToSecond: {
      customers: 400,
      repeated: 160,
      censored: 240,
      within: [
        { days: 30, share: 0.21, observedCustomers: 380 },
        { days: 90, share: 0.38, observedCustomers: 300 },
      ],
      quantiles: { p25: 41, median: null, p75: null },
      repeaters: { p25: 10, median: 22, p75: 45 },
      curve: [
        { days: 0, share: 0 },
        { days: 30, share: 0.21 },
      ],
    },
    byCohort: [
      { cohort: '2025-11', size: 40, repeated: 20, within90: 0.4, ...rate(0.5) },
      { cohort: '2026-10', size: 12, repeated: 1, within90: null, ...rate(0.08, true) },
    ],
  },
};

const clv = {
  meta: meta('historical_clv'),
  data: {
    summary: {
      customers: 400,
      mean: 30_000_000,
      median: 12_000_000,
      p25: 6_000_000,
      p75: 30_000_000,
      p90: 80_000_000,
      total: 12_000_000_000,
      top10Share: 0.45,
    },
    distribution: [
      { min: 0, max: 10_000_000, count: 200 },
      { min: 10_000_000, max: null, count: 200 },
    ],
    byCohort: [
      {
        cohort: '2025-11',
        size: 40,
        lowSample: false,
        toDate: 25_000_000,
        withinDays: { '90': 10_000_000, '180': 15_000_000, '365': 22_000_000 },
      },
      {
        cohort: '2026-10',
        size: 12,
        lowSample: true,
        toDate: 5_000_000,
        withinDays: { '90': null, '180': null, '365': null },
      },
    ],
    bySegment: [
      {
        segment: 'champions',
        customers: 50,
        mean: 120_000_000,
        median: 90_000_000,
        total: 6_000_000_000,
        revenueShare: 0.5,
        lowSample: false,
      },
    ],
  },
};

const journey = {
  meta: meta('journey_funnel'),
  data: {
    stages: [
      { stage: 'registered', customers: 500 },
      { stage: 'first', customers: 400, conversion: rate(0.8) },
      { stage: 'second', customers: 160, conversion: rate(0.4) },
      { stage: 'third', customers: 90, conversion: rate(0.5625) },
      { stage: 'active', customers: 200, conversion: rate(0.5) },
    ],
    timing: [
      {
        from: 'registered',
        to: 'first',
        customers: 500,
        reached: 400,
        censored: 100,
        medianDays: 0,
        observedMedianDays: 0,
      },
      {
        from: 'first',
        to: 'second',
        customers: 400,
        reached: 160,
        censored: 240,
        medianDays: null,
        observedMedianDays: 22,
      },
    ],
    beforeFirstPurchase: {
      firstPurchasers: 400,
      withInteractions: 120,
      types: [{ type: 'website_visit', customers: 100, share: 0.25 }],
    },
  },
};

const engagement = {
  meta: meta('engagement_score'),
  data: {
    volume: {
      total: 900,
      customers: 300,
      byType: [{ type: 'email_opened', count: 900 }],
      byChannel: [{ channel: 'email', count: 900 }],
      series: [{ period: '2026-10-01', counts: { ...counts, email_opened: 900 } }],
    },
    engagedRate: { alive: 600, engaged: 300, ...rate(0.5) },
    scores: {
      scored: 300,
      distribution: [{ min: 0, max: 10, count: 30 }],
      median: 50,
    },
    correlation: { rho: 0.31, customers: 550, lowSample: false },
    config: { weights: DEFAULT_ENGAGEMENT_WEIGHTS, cap: 10, windowDays: 90 },
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
  'GET /analytics/frequency': () => ({ status: 200, body: frequency }),
  'GET /analytics/clv': () => ({ status: 200, body: clv }),
  'GET /analytics/journey': () => ({ status: 200, body: journey }),
  'GET /analytics/engagement': () => ({ status: 200, body: engagement }),
};
const viewer = { status: 'authenticated' as const, session: makeSession('VIEWER') };

describe('ValuePage', () => {
  it('shows frequency with a censoring-aware time to second purchase', async () => {
    mockApi(base);
    renderApp('/value', viewer);
    const repeat = (await screen.findByText(/160 of 400 customers bought again/)).parentElement!;
    expect(within(repeat).getByText('40.0%')).toBeInTheDocument();
    expect(
      screen.getByText(/240 of 400 customers have not bought a second time yet/),
    ).toBeInTheDocument();
    expect(screen.getByText('Recent customers may still come back.')).toBeInTheDocument();
    const horizons = screen.getByRole('table', { name: 'Time to second purchase' });
    expect(within(horizons).getByRole('row', { name: /30 days/ })).toHaveTextContent('21%');
    expect(screen.getAllByText('Not reached yet')).toHaveLength(2);
    const cohorts = screen.getByRole('table', { name: 'Repeat rate by acquisition month' });
    const october = within(cohorts).getByRole('row', { name: /Oct 2026/ });
    expect(within(october).getByText('Not yet available')).toBeInTheDocument();
    expect(within(october).getByText('Fewer than 30 customers')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('labels CLV as measured and hides horizons that have not passed', async () => {
    mockApi(base);
    renderApp('/value?tab=clv', viewer);
    expect(await screen.findByText(/Nothing on this page is a forecast/)).toBeInTheDocument();
    const cohorts = screen.getByRole('table', { name: 'Lifetime value by acquisition month' });
    const october = within(cohorts).getByRole('row', { name: /Oct 2026/ });
    expect(within(october).getAllByText('Not yet available')).toHaveLength(3);
    const november = within(cohorts).getByRole('row', { name: /Nov 2025/ });
    expect(within(november).getByText(/220,000/)).toBeInTheDocument();
    const segments = screen.getByRole('table', { name: 'Lifetime value by segment' });
    expect(within(segments).getByRole('row', { name: /Champions/ })).toHaveTextContent('50.0%');
  });

  it('draws the journey funnel and stage timing', async () => {
    mockApi(base);
    renderApp('/value?tab=journey', viewer);
    const funnel = await screen.findByRole('list', { name: 'Customer journey' });
    expect(within(funnel).getByText('Second purchase')).toBeInTheDocument();
    expect(within(funnel).getByText('40% of the previous step')).toBeInTheDocument();
    expect(within(funnel).getByText('50% of first-time buyers')).toBeInTheDocument();
    const timing = screen.getByRole('table', { name: 'Time between steps' });
    expect(
      within(timing).getByRole('row', { name: /First purchase → Second purchase/ }),
    ).toHaveTextContent('Not reached yet');
    expect(screen.getByRole('row', { name: /Website visit/ })).toHaveTextContent('25%');
  });

  it('shows engagement with the correlation caveat and weights', async () => {
    mockApi(base);
    renderApp('/value?tab=engagement', viewer);
    expect(await screen.findByText(/300 of 600 current customers/)).toBeInTheDocument();
    expect(screen.getByText(/Spearman ρ = 0.31 over 550 customers/)).toBeInTheDocument();
    expect(screen.getByText(/not proof that engagement causes purchases/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Interactions by type' })).toBeInTheDocument();
  });

  it('sends the period and segment filters', async () => {
    const fetchMock = mockApi(base);
    renderApp('/value', viewer);
    await screen.findByText(/160 of 400 customers bought again/);
    await userEvent.selectOptions(screen.getByLabelText('Segment'), 'champions');
    await userEvent.selectOptions(screen.getByLabelText('Customers acquired in'), 'last_24_months');
    await screen.findByText(/160 of 400 customers bought again/);
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(
      urls.some((u) => u.includes('/analytics/frequency') && u.includes('segment=champions')),
    ).toBe(true);
    const range = lastMonths(24, todayIn('America/Bogota'));
    expect(
      urls.some((u) => u.includes(`start=${range.start}`) && u.includes(`end=${range.end}`)),
    ).toBe(true);
  });
});

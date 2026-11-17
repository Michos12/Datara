import { DEFAULT_SEGMENT_CONFIG, type Recommendation } from '@ci/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';
import { formatMetric } from './RecommendationDetailPage';

const ID = '0193a2b4-0000-7000-8000-00000000a001';

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: ID,
    ruleKey: 'churn_risk_high_value',
    ruleVersion: 1,
    priority: 'high',
    priorityScore: 0.12,
    status: 'open',
    title: '42 high-value customers are at risk of churning',
    opportunity: 'Protect revenue from customers who have gone quiet.',
    explanation: 'They have not bought for 1.5× their usual interval.',
    suggestedAction: 'Personalised win-back offer within 14 days.',
    metrics: {
      affectedCustomers: 42,
      medianUsualGapDays: 38,
      shareOfLast12mRevenue: 0.18,
      historicalRevenueCents: 912_000_000,
    },
    affectedCustomers: 42,
    revenueAtStakeCents: 164_000_000,
    revenueAtStakeBasis: 'measured',
    dismissReason: null,
    statusChangedAt: null,
    firstDetectedAt: '2026-11-02T07:00:00.000Z',
    lastDetectedAt: '2026-11-15T07:00:00.000Z',
    ...overrides,
  };
}

const second = recommendation({
  id: '0193a2b4-0000-7000-8000-00000000a002',
  ruleKey: 'loyalty_programme',
  priority: 'low',
  status: 'acknowledged',
  title: '120 regular customers could become Champions',
  revenueAtStakeCents: null,
});

const config = {
  id: '0193a2b4-0000-7000-8000-00000000f001',
  version: 1,
  isActive: true,
  config: DEFAULT_SEGMENT_CONFIG,
  createdAt: '2026-11-16T00:00:00.000Z',
};

const customers = {
  data: [
    {
      customerId: '0193a2b4-0000-7000-8000-0000000000c1',
      externalId: 'C-1',
      firstName: 'Lucía',
      lastName: 'Gómez',
      email: 'lucia@example.com',
      valueCents: 125_000_000,
      segment: 'at_risk',
      lastOrderDate: '2026-08-20',
    },
  ],
  page: { nextCursor: null, limit: 25, total: 1 },
};

const owner = { status: 'authenticated' as const, session: makeSession('OWNER') };
const viewer = { status: 'authenticated' as const, session: makeSession('VIEWER') };

describe('Recommendations', () => {
  it('lists open recommendations and switches views', async () => {
    const fetchMock = mockApi({
      ...READY,
      'GET /recommendations': () => ({ status: 200, body: { data: [recommendation(), second] } }),
    });
    renderApp('/recommendations', viewer);
    const list = await screen.findByRole('list', { name: 'Recommendations' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Priority: High')).toBeInTheDocument();
    expect(within(items[0]!).getByText('COP 1,640,000')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Acknowledged')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('status=open%2Cacknowledged')),
    ).toBe(true);
    await userEvent.click(screen.getByRole('tab', { name: 'Dismissed' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('status=dismissed'))).toBe(true),
    );
  });

  it('shows the detail with measured revenue, metrics and affected customers', async () => {
    mockApi({
      ...READY,
      'GET /segments/config': () => ({ status: 200, body: config }),
      [`GET /recommendations/${ID}`]: () => ({ status: 200, body: recommendation() }),
      [`GET /recommendations/${ID}/customers`]: () => ({ status: 200, body: customers }),
    });
    renderApp(`/recommendations/${ID}`, owner);
    expect(
      await screen.findByRole('heading', {
        name: '42 high-value customers are at risk of churning',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Measured, not a forecast/)).toBeInTheDocument();
    expect(screen.getByText('Personalised win-back offer within 14 days.')).toBeInTheDocument();
    expect(screen.getByText('Share of last 12 months revenue')).toBeInTheDocument();
    expect(screen.getByText('18.0%')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Lucía Gómez' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
  });

  it('asks for a reason before dismissing', async () => {
    let sent: unknown = null;
    const fetchMock = mockApi({
      ...READY,
      'GET /segments/config': () => ({ status: 200, body: config }),
      [`GET /recommendations/${ID}`]: () => ({ status: 200, body: recommendation() }),
      [`GET /recommendations/${ID}/customers`]: () => ({ status: 200, body: customers }),
      'GET /recommendations': () => ({ status: 200, body: { data: [] } }),
      [`PATCH /recommendations/${ID}`]: (init) => {
        sent = JSON.parse(String(init?.body));
        return {
          status: 200,
          body: recommendation({
            status: 'dismissed',
            dismissReason: 'Seasonal lull',
            statusChangedAt: '2026-11-16T10:00:00.000Z',
          }),
        };
      },
    });
    renderApp(`/recommendations/${ID}`, owner);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    const dialog = screen.getByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Dismiss' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Seasonal lull');
    await userEvent.click(submit);
    expect(await screen.findByText('Dismissed: Seasonal lull')).toBeInTheDocument();
    expect(sent).toEqual({ status: 'dismissed', dismissReason: 'Seasonal lull' });
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'PATCH')).toHaveLength(1);
  });

  it('gives viewers the analysis without actions or customer lists', async () => {
    const fetchMock = mockApi({
      ...READY,
      [`GET /recommendations/${ID}`]: () => ({ status: 200, body: recommendation() }),
    });
    renderApp(`/recommendations/${ID}`, viewer);
    await screen.findByRole('heading', { name: '42 high-value customers are at risk of churning' });
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
    expect(screen.queryByText('Affected customers', { selector: 'h2' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/customers'))).toBe(false);
  });

  it('formats supporting metrics by kind', () => {
    expect(formatMetric('historicalRevenueCents', 912_000_000, 'COP')).toMatch(/^COP\s9,120,000$/);
    expect(formatMetric('shareOfActive', 0.2, 'COP')).toBe('20.0%');
    expect(formatMetric('pValue', 0.0001, 'COP')).toBe('< 0.001');
    expect(formatMetric('medianUsualGapDays', 38.25, 'COP')).toBe('38.3');
  });
});

describe('Overview top recommendations', () => {
  it('shows the top three open recommendations', async () => {
    const fetchMock = mockApi({
      ...READY,
      'GET /recommendations': () => ({ status: 200, body: { data: [recommendation(), second] } }),
    });
    renderApp('/', owner);
    const top = await screen.findByRole('list', { name: 'Top recommendations' });
    expect(within(top).getAllByRole('listitem')).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('limit=3'))).toBe(true);
  });
});

import { DEFAULT_SEGMENT_CONFIG, type SegmentsResponse } from '@ci/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';

const configVersion = {
  id: '0193a2b4-0000-7000-8000-00000000f001',
  version: 1,
  isActive: true,
  config: DEFAULT_SEGMENT_CONFIG,
  createdAt: '2026-11-16T00:00:00.000Z',
};

function summary(): SegmentsResponse {
  const matrix = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  matrix[4]![4] = 12;
  return {
    run: { id: '0193a2b4-0000-7000-8000-00000000f002', asOf: '2026-11-16', configVersion: 1 },
    lookbackDays: 365,
    noPurchases: 7,
    matrix,
    segments: DEFAULT_SEGMENT_CONFIG.rules.map((r, i) => ({
      key: r.key,
      name: r.name,
      color: r.color,
      description: r.description,
      customers: i === 0 ? 12 : 1,
      customerShare: i === 0 ? 0.5 : 0.05,
      revenueShare: i === 0 ? 0.62 : 0.04,
      avgRecencyDays: 9,
      avgOrders: 7.5,
      avgSpendCents: 120000,
      avgClvCents: 450000,
    })),
  };
}

const base = {
  ...READY,
  'GET /segments/config': () => ({ status: 200, body: configVersion }),
  'GET /segments': () => ({ status: 200, body: summary() }),
};

describe('SegmentsPage', () => {
  it('summarizes segments with shares and links to their customers', async () => {
    mockApi(base);
    renderApp('/segments', { status: 'authenticated', session: makeSession('OWNER') });
    const link = await screen.findByRole('link', { name: 'Champions' });
    expect(link).toHaveAttribute('href', '/customers?segment=champions');
    const row = link.closest('tr')!;
    expect(within(row).getByText('12')).toBeInTheDocument();
    expect(within(row).getByText(/62\.0\s?%/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'No purchases' })).toHaveAttribute(
      'href',
      '/customers?segment=no_purchases',
    );
    expect(screen.getByRole('img', { name: 'Recency × frequency' })).toBeInTheDocument();
  });

  it('explains that segments need a first analytics run', async () => {
    mockApi({
      ...base,
      'GET /segments': () => ({
        status: 200,
        body: { run: null, lookbackDays: 365, segments: [], noPurchases: 0, matrix: [] },
      }),
    });
    renderApp('/segments', { status: 'authenticated', session: makeSession('ADMIN') });
    expect(
      await screen.findByText(/Segments appear after the first analytics run/),
    ).toBeInTheDocument();
  });

  it('hides editing from analysts and viewers', async () => {
    mockApi(base);
    renderApp('/segments', { status: 'authenticated', session: makeSession('ANALYST') });
    await screen.findByRole('link', { name: 'Champions' });
    expect(screen.queryByRole('button', { name: 'Edit segment rules' })).not.toBeInTheDocument();
  });

  it('previews and saves edited rules', async () => {
    let saved: { config: { rules: { key: string; name: string }[] } } | undefined;
    mockApi({
      ...base,
      'POST /segments/config/preview': () => ({
        status: 200,
        body: {
          asOf: '2026-11-16',
          counts: { champions: 40, lost: 3 },
          noPurchases: 2,
          matrix: summary().matrix,
        },
      }),
      'POST /segments/config': (init) => {
        saved = JSON.parse(String(init?.body));
        return { status: 201, body: { ...configVersion, version: 2 } };
      },
    });
    renderApp('/segments', { status: 'authenticated', session: makeSession('OWNER') });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit segment rules' }));

    const name = screen.getByLabelText('Name of segment champions');
    await userEvent.clear(name);
    await userEvent.type(name, 'VIPs');
    await userEvent.click(screen.getByRole('button', { name: 'Preview counts' }));
    expect(await screen.findByText('40')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save and apply' }));
    await screen.findByRole('button', { name: 'Edit segment rules' }); // editor closed
    expect(saved?.config.rules[0]).toMatchObject({ key: 'champions', name: 'VIPs' });
  });

  it('blocks saving when a score combination has no segment', async () => {
    mockApi(base);
    renderApp('/segments', { status: 'authenticated', session: makeSession('OWNER') });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit segment rules' }));
    // Narrow "Lost" (R1, F1–2) to F2 only: R1F1 is no longer covered.
    await userEvent.selectOptions(screen.getByLabelText('Lost F min'), '2');
    expect(screen.getByText(/These score combinations have no segment: R1F1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and apply' })).toBeDisabled();
  });
});

describe('customer segment filter', () => {
  it('reads the segment from the URL and sends it to the API', async () => {
    const fetchMock = mockApi({
      ...base,
      'GET /customers': () => ({
        status: 200,
        body: { data: [], page: { nextCursor: null, limit: 50 } },
      }),
    });
    renderApp('/customers?segment=champions', {
      status: 'authenticated',
      session: makeSession('OWNER'),
    });
    await screen.findByText('No customers match these filters.');
    expect(screen.getByLabelText('Segment')).toHaveValue('champions');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('segment=champions'))).toBe(true);
  });
});

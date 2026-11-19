import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';
import { formatDifference } from './ReportsPage';

const comparison = {
  periodA: { start: '2026-09-01', end: '2026-10-01' },
  periodB: { start: '2026-10-01', end: '2026-11-01' },
  segment: null,
  currency: 'COP',
  rows: [
    {
      key: 'revenue_net',
      unit: 'money',
      kind: 'measured',
      a: 100_000_000,
      b: 125_000_000,
      difference: 25_000_000,
      relativeChange: 0.25,
    },
    {
      key: 'retention_rate',
      unit: 'ratio',
      kind: 'measured',
      a: 0.3,
      b: 0.25,
      difference: -0.05,
      relativeChange: null,
    },
  ],
  warnings: [],
};

describe('Reports page', () => {
  it('compares two periods with points for ratios', async () => {
    const fetchMock = mockApi({
      ...READY,
      'GET /reports/comparison': () => ({ status: 200, body: comparison }),
    });
    renderApp('/reports', { status: 'authenticated', session: makeSession('VIEWER') });
    await userEvent.click(await screen.findByRole('button', { name: 'Compare' }));
    const table = await screen.findByRole('table', { name: 'Compare two periods' });
    const revenue = within(table).getByRole('row', { name: /Net revenue/ });
    expect(revenue).toHaveTextContent('+25.0%');
    const retention = within(table).getByRole('row', { name: /Retention rate/ });
    expect(retention).toHaveTextContent('−5.0 pts');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('aStart='))).toBe(true);
    // Viewers get KPI and chart exports, not personal-data exports or PDFs.
    expect(screen.queryByRole('button', { name: 'Orders' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate PDF' })).not.toBeInTheDocument();
  });

  it('generates a PDF in the background and offers the download', async () => {
    let polls = 0;
    mockApi({
      ...READY,
      'POST /reports/pdf': () => ({
        status: 202,
        body: { jobId: '0193a2b4-0000-7000-8000-00000000b001' },
      }),
      'GET /reports/pdf/0193a2b4-0000-7000-8000-00000000b001': () => {
        polls++;
        return {
          status: 200,
          body: {
            id: '0193a2b4-0000-7000-8000-00000000b001',
            status: polls > 1 ? 'succeeded' : 'running',
            fileName: polls > 1 ? 'report.pdf' : null,
            error: null,
            createdAt: '2026-11-17T00:00:00.000Z',
            finishedAt: null,
          },
        };
      },
    });
    renderApp('/reports', { status: 'authenticated', session: makeSession('ANALYST') });
    await userEvent.click(await screen.findByRole('button', { name: 'Generate PDF' }));
    expect(await screen.findByText('Generating the report…')).toBeInTheDocument();
    expect(
      await screen.findByText('Your report is ready.', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument();
  });

  it('formats differences by unit', () => {
    const row = comparison.rows[0]! as Parameters<typeof formatDifference>[0];
    expect(formatDifference(row, 'COP')).toMatch(/^\+COP\s250,000$/);
    expect(formatDifference({ ...row, unit: 'count', difference: -3 }, 'COP')).toBe('−3');
  });
});

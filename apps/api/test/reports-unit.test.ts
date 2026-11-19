import type { Kpi } from '@ci/contracts';
import { describe, expect, it } from 'vitest';
import { invitationEmail, passwordResetEmail } from '../src/modules/auth/emails.js';
import { buildReportPdf, pdfText } from '../src/modules/reports/pdf.js';
import { csvCell } from '../src/modules/reports/report.routes.js';
import { compareKpis, comparisonTable, moneyConverter } from '../src/modules/reports/tables.js';

const kpi = (key: string, unit: Kpi['unit'], value: number | null): Kpi => ({
  key,
  unit,
  value,
  previous: null,
  change: null,
  changeType: unit === 'ratio' ? 'points' : 'relative',
  kind: 'measured',
});

describe('period comparison', () => {
  const a = [
    kpi('revenue_net', 'money', 80_000),
    kpi('orders', 'count', 0),
    kpi('retention_rate', 'ratio', 0.4),
    kpi('aov', 'money', null),
    kpi('buyers', 'count', 50),
  ];
  const b = [
    kpi('revenue_net', 'money', 60_000),
    kpi('orders', 'count', 12),
    kpi('retention_rate', 'ratio', 0.45),
    kpi('aov', 'money', 5000),
  ];

  it('computes B − A and the relative change against |A|', () => {
    const rows = Object.fromEntries(compareKpis(a, b).map((r) => [r.key, r]));
    expect(rows.revenue_net).toMatchObject({ a: 80_000, b: 60_000, difference: -20_000 });
    expect(rows.revenue_net!.relativeChange).toBeCloseTo(-0.25);
    // From zero there is no meaningful relative change.
    expect(rows.orders).toMatchObject({ difference: 12, relativeChange: null });
    // Ratios differ in points only.
    expect(rows.retention_rate!.difference).toBeCloseTo(0.05);
    expect(rows.retention_rate!.relativeChange).toBeNull();
    expect(rows.aov).toMatchObject({ difference: null, relativeChange: null });
    expect(rows.buyers).toMatchObject({ b: null, difference: null });
  });

  it('writes money in major units for the currency', () => {
    const table = comparisonTable(compareKpis(a, b), 'USD');
    expect(table.rows[0]).toEqual(['revenue_net', 'money_USD', 800, 600, -200, -0.25]);
    expect(moneyConverter('JPY')(1234)).toBe(1234);
    expect(moneyConverter('KWD')(1234)).toBe(1.234);
    expect(moneyConverter('USD')(null)).toBeNull();
  });
});

describe('CSV cells', () => {
  it('neutralises formulas and keeps numbers as numbers', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('plain, text')).toBe('plain, text');
    expect(csvCell(-0.25)).toBe('-0.25');
    expect(csvCell(null)).toBe('');
    expect(csvCell(false)).toBe('false');
  });
});

describe('PDF report', () => {
  it('maps typographic characters to the PDF font encoding', () => {
    expect(pdfText('F ≥ 4 × 1.5 → “ok” − done… ρ 日本')).toBe(
      'F >= 4 x 1.5 -> "ok" - done... rho ??',
    );
    expect(pdfText('Medellín, São Paulo')).toBe('Medellín, São Paulo');
  });

  it('renders every section to a PDF', async () => {
    const pdf = await buildReportPdf({
      organizationName: 'Café Central',
      currency: 'COP',
      minorUnits: 2,
      period: { start: '2026-09-01', end: '2026-11-01' },
      segment: null,
      generatedAt: '2026-11-17 10:00 UTC',
      sections: ['overview', 'segments', 'retention', 'recommendations'],
      kpis: [
        {
          name: 'Net revenue',
          unit: 'money',
          value: 12_345_600,
          previous: 10_000_000,
          change: 0.23,
          changeType: 'relative',
        },
      ],
      segments: [],
      retention: [
        { label: '2026-09', rate: 0.3, base: 120 },
        { label: '2026-10', rate: null, base: 0 },
      ],
      recommendations: [],
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

describe('emails', () => {
  it('escapes names in the HTML version and keeps the link in plain text', () => {
    const email = invitationEmail({
      to: 'x@example.com',
      link: 'http://app.test/invitation#token=abc',
      organizationName: 'Tom & <Jerry>',
      inviterName: null,
      role: 'ANALYST',
      days: 7,
    });
    expect(email.subject).toBe('Join Tom & <Jerry> on Customer Insights');
    expect(email.html).toContain('Tom &amp; &lt;Jerry&gt;');
    expect(email.html).not.toContain('<Jerry>');
    expect(email.text).toContain('as Analyst');
    expect(passwordResetEmail('y@example.com', 'http://l', 60).text).toContain('expires in 60');
  });
});

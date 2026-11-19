import type { PdfSection, Recommendation, SegmentSummary } from '@ci/contracts';
import PDFDocument from 'pdfkit';

/** Everything a PDF report shows, already fetched (RPT-05). Money in minor units. */
export interface ReportData {
  organizationName: string;
  currency: string;
  minorUnits: number;
  period: { start: string; end: string };
  segment: string | null;
  generatedAt: string;
  sections: PdfSection[];
  kpis: {
    name: string;
    unit: string;
    value: number | null;
    previous: number | null;
    change: number | null;
    changeType: 'relative' | 'points';
  }[];
  segments: SegmentSummary[];
  retention: { label: string; rate: number | null; base: number }[];
  recommendations: Recommendation[];
}

const INK = '#161a22';
const MUTED = '#5b6474';
const ACCENT = '#2f5bd3';
const LINE = '#e2e5ea';

/**
 * The built-in PDF fonts use WinAnsi encoding: map the typographic characters our texts use
 * to safe equivalents and drop anything else outside Latin-1, so nothing renders as garbage.
 */
export function pdfText(text: string): string {
  return text
    .replace(/[−–—]/g, '-')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/×/g, 'x')
    .replace(/→/g, '->')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/ρ/g, 'rho')
    .replace(/[\s\S]/g, (c) => (c.charCodeAt(0) > 0xff ? '?' : c));
}

function formatters(data: ReportData) {
  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: data.currency,
    maximumFractionDigits: data.minorUnits,
    minimumFractionDigits: data.minorUnits,
  });
  return {
    value(unit: string, v: number | null): string {
      if (v === null) return '-';
      if (unit === 'money') return money.format(v / 10 ** data.minorUnits);
      if (unit === 'ratio') return `${(v * 100).toFixed(1)}%`;
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v);
    },
    money: (minor: number | null) =>
      minor === null ? '-' : money.format(minor / 10 ** data.minorUnits),
    change(change: number | null, type: 'relative' | 'points'): string {
      if (change === null) return '-';
      const v = change * 100;
      const sign = v > 0 ? '+' : '';
      return type === 'points' ? `${sign}${v.toFixed(1)} pts` : `${sign}${v.toFixed(1)}%`;
    },
  };
}

/** Renders the report to a PDF buffer with PDFKit (no browser needed). */
export function buildReportPdf(data: ReportData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: 'Customer Insights report' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const f = formatters(data);
  const width = doc.page.width - 96;

  const heading = (text: string) => {
    if (doc.y > doc.page.height - 160) doc.addPage();
    doc.moveDown(1).fillColor(INK).font('Helvetica-Bold').fontSize(14).text(pdfText(text));
    doc.moveDown(0.4);
  };
  const table = (
    columns: { label: string; width: number; align?: 'left' | 'right' }[],
    rows: string[][],
  ) => {
    const draw = (cells: string[], bold: boolean) => {
      if (doc.y > doc.page.height - 72) doc.addPage();
      const y = doc.y;
      let x = 48;
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(9)
        .fillColor(bold ? MUTED : INK);
      cells.forEach((cell, i) => {
        const col = columns[i]!;
        doc.text(pdfText(cell), x, y, { width: col.width - 6, align: col.align ?? 'left' });
        x += col.width;
      });
      doc
        .moveTo(48, doc.y + 2)
        .lineTo(48 + width, doc.y + 2)
        .strokeColor(LINE)
        .lineWidth(0.5)
        .stroke();
      doc.y += 5;
    };
    draw(
      columns.map((c) => c.label),
      true,
    );
    rows.forEach((r) => draw(r, false));
    doc.x = 48;
  };

  // Title
  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(20).text('Customer Insights report');
  doc.fillColor(INK).font('Helvetica').fontSize(11).text(pdfText(data.organizationName));
  doc
    .fillColor(MUTED)
    .fontSize(9)
    .text(
      pdfText(
        `Period ${data.period.start} to ${data.period.end} (end exclusive)` +
          (data.segment ? ` - segment: ${data.segment}` : ' - all customers') +
          ` - generated ${data.generatedAt}`,
      ),
    );

  if (data.sections.includes('overview')) {
    heading('Key figures');
    table(
      [
        { label: 'KPI', width: width * 0.4 },
        { label: 'This period', width: width * 0.2, align: 'right' },
        { label: 'Previous period', width: width * 0.2, align: 'right' },
        { label: 'Change', width: width * 0.2, align: 'right' },
      ],
      data.kpis.map((k) => [
        k.name,
        f.value(k.unit, k.value),
        f.value(k.unit, k.previous),
        f.change(k.change, k.changeType),
      ]),
    );
  }

  if (data.sections.includes('segments')) {
    heading('Customer segments');
    if (data.segments.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('No analytics snapshot yet.');
    } else {
      table(
        [
          { label: 'Segment', width: width * 0.34 },
          { label: 'Customers', width: width * 0.16, align: 'right' },
          { label: 'Share', width: width * 0.16, align: 'right' },
          { label: 'Revenue share', width: width * 0.17, align: 'right' },
          { label: 'Avg. lifetime value', width: width * 0.17, align: 'right' },
        ],
        data.segments.map((s) => [
          s.name,
          String(s.customers),
          `${(s.customerShare * 100).toFixed(1)}%`,
          `${(s.revenueShare * 100).toFixed(1)}%`,
          f.money(s.avgClvCents),
        ]),
      );
    }
  }

  if (data.sections.includes('retention')) {
    heading('Retention by month');
    const points = data.retention;
    // A simple bar chart: one bar per month, height = retention rate.
    const chartTop = doc.y + 4;
    const chartHeight = 90;
    const barWidth = points.length ? Math.min(28, width / points.length - 4) : 0;
    points.forEach((p, i) => {
      const h = (p.rate ?? 0) * chartHeight;
      const x = 48 + i * (barWidth + 4);
      doc
        .rect(x, chartTop + chartHeight - h, barWidth, h)
        .fillColor(ACCENT)
        .fill();
    });
    doc.y = chartTop + chartHeight + 8;
    table(
      [
        { label: 'Month', width: width * 0.4 },
        { label: 'Bought in previous month', width: width * 0.3, align: 'right' },
        { label: 'Retention', width: width * 0.3, align: 'right' },
      ],
      points.map((p) => [
        p.label,
        String(p.base),
        p.rate === null ? '-' : `${(p.rate * 100).toFixed(1)}%`,
      ]),
    );
  }

  if (data.sections.includes('recommendations')) {
    heading('Recommendations');
    if (data.recommendations.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('No open recommendations.');
    }
    for (const r of data.recommendations) {
      if (doc.y > doc.page.height - 120) doc.addPage();
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor(INK)
        .text(pdfText(`[${r.priority.toUpperCase()}] ${r.title}`));
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(pdfText(r.explanation));
      doc.fillColor(INK).text(pdfText(`Suggested action: ${r.suggestedAction}`));
      if (r.revenueAtStakeCents !== null) {
        doc
          .fillColor(MUTED)
          .text(
            pdfText(
              `Revenue at stake (last 12 months, measured): ${f.money(r.revenueAtStakeCents)}`,
            ),
          );
      }
      doc.moveDown(0.6);
    }
  }

  doc.end();
  return done;
}

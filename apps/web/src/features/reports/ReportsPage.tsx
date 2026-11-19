import {
  comparisonResponseSchema,
  PDF_SECTIONS,
  reportJobSchema,
  type ComparisonRow,
  type PdfSection,
} from '@ci/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, SelectField, TextField } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { ApiError, apiDownload, apiGet, apiRequest } from '../../lib/api';
import { formatMoney, formatPercent } from '../../lib/format';
import { useSession } from '../auth/AuthProvider';
import { lastMonths } from '../behavior/BehaviorPage';
import { monthStart, todayIn } from '../overview/periods';
import { useSegmentConfig } from '../segments/queries';

interface Periods {
  aStart: string;
  aEnd: string;
  bStart: string;
  bEnd: string;
  segment: string;
}

function query(p: Periods): string {
  const params = new URLSearchParams({
    aStart: p.aStart,
    aEnd: p.aEnd,
    bStart: p.bStart,
    bEnd: p.bEnd,
  });
  if (p.segment) params.set('segment', p.segment);
  return params.toString();
}

/** A KPI value in its unit; money is minor units. */
export function formatValue(unit: string, value: number | null, currency: string): string {
  if (value === null) return '—';
  if (unit === 'money') return formatMoney(Math.round(value), currency);
  if (unit === 'ratio') return formatPercent(value);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

export function formatDifference(row: ComparisonRow, currency: string): string {
  if (row.difference === null) return '—';
  const sign = row.difference > 0 ? '+' : row.difference < 0 ? '−' : '';
  const abs = Math.abs(row.difference);
  if (row.unit === 'ratio') return `${sign}${(abs * 100).toFixed(1)} pts`;
  if (row.unit === 'money') return `${sign}${formatMoney(Math.round(abs), currency)}`;
  return `${sign}${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(abs)}`;
}

/** Period comparison, CSV exports and PDF reports (RPT-02 … 05). */
export function ReportsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const { currency, timezone } = session.organization;
  const canExport = session.role !== 'VIEWER';
  const today = todayIn(timezone);
  const segmentConfig = useSegmentConfig();
  const [draft, setDraft] = useState<Periods>(() => {
    const b = lastMonths(1, today);
    return {
      aStart: monthStart(today, -2),
      aEnd: b.start,
      bStart: b.start,
      bEnd: b.end,
      segment: '',
    };
  });
  const [submitted, setSubmitted] = useState<Periods | null>(null);
  const comparison = useQuery({
    queryKey: ['reports', 'comparison', submitted],
    enabled: submitted !== null,
    queryFn: ({ signal }) =>
      apiGet(`/reports/comparison?${query(submitted!)}`, {
        schema: comparisonResponseSchema,
        signal,
      }),
  });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  async function download(path: string, name: string) {
    setDownloadError(null);
    try {
      await apiDownload(path, name);
    } catch (err) {
      setDownloadError(err instanceof ApiError ? err.message : t('errors.network'));
    }
  }

  const set = (key: keyof Periods) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));
  const periodA = new URLSearchParams({ start: draft.aStart, end: draft.aEnd });
  if (draft.segment) periodA.set('segment', draft.segment);

  return (
    <>
      <PageHeader title={t('reports.title')} description={t('reports.description')} />

      <Card>
        <h2 className="text-sm font-semibold">{t('reports.comparison')}</h2>
        <p className="mb-3 mt-1 text-xs text-ink-muted">{t('reports.comparisonHint')}</p>
        <form
          className="grid gap-3 md:grid-cols-5 md:items-end"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setSubmitted({ ...draft });
          }}
        >
          <fieldset className="grid grid-cols-2 gap-2 md:col-span-2">
            <legend className="mb-1 text-sm font-medium">{t('reports.periodA')}</legend>
            <TextField
              label={t('reports.from')}
              type="date"
              value={draft.aStart}
              onChange={set('aStart')}
            />
            <TextField
              label={t('reports.to')}
              type="date"
              value={draft.aEnd}
              onChange={set('aEnd')}
            />
          </fieldset>
          <fieldset className="grid grid-cols-2 gap-2 md:col-span-2">
            <legend className="mb-1 text-sm font-medium">{t('reports.periodB')}</legend>
            <TextField
              label={t('reports.from')}
              type="date"
              value={draft.bStart}
              onChange={set('bStart')}
            />
            <TextField
              label={t('reports.to')}
              type="date"
              value={draft.bEnd}
              onChange={set('bEnd')}
            />
          </fieldset>
          <SelectField
            label={t('overview.segment')}
            value={draft.segment}
            onChange={set('segment')}
            options={[
              { value: '', label: t('overview.allCustomers') },
              ...(segmentConfig.data?.config.rules ?? []).map((r) => ({
                value: r.key,
                label: r.name,
              })),
            ]}
          />
          <div className="flex gap-2 md:col-span-5">
            <Button type="submit">{t('reports.compare')}</Button>
            {comparison.data && (
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  void download(`/exports/comparison.csv?${query(submitted!)}`, 'comparison.csv')
                }
              >
                {t('reports.downloadCsv')}
              </Button>
            )}
          </div>
        </form>

        {comparison.error && (
          <div className="mt-3">
            <Alert tone="error">
              {comparison.error instanceof ApiError
                ? comparison.error.message
                : t('errors.generic')}
            </Alert>
          </div>
        )}
        {comparison.data?.warnings.map((w) => (
          <div key={w.code} className="mt-3">
            <Alert tone="info">{w.message}</Alert>
          </div>
        ))}
        {comparison.data && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('reports.comparison')}</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th scope="col" className="py-2 font-medium">
                    {t('reports.kpi')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('reports.periodA')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('reports.periodB')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('reports.difference')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('reports.change')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {comparison.data.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className="py-2 text-left font-normal">
                      {t(`kpis.${row.key}`, { defaultValue: row.key })}
                    </th>
                    <td className="py-2 text-right tabular-nums">
                      {formatValue(row.unit, row.a, currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatValue(row.unit, row.b, currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatDifference(row, currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {row.relativeChange === null
                        ? '—'
                        : `${row.relativeChange > 0 ? '+' : ''}${formatPercent(row.relativeChange)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold">{t('reports.exports')}</h2>
        <p className="mb-3 mt-1 text-xs text-ink-muted">{t('reports.exportsHint')}</p>
        {downloadError && (
          <div className="mb-3">
            <Alert tone="error">{downloadError}</Alert>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => void download(`/exports/kpis.csv?${periodA}`, 'kpis.csv')}
          >
            {t('reports.exportKpis')}
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void download(`/exports/analytics/overview.csv?${periodA}`, 'overview.csv')
            }
          >
            {t('reports.exportCharts')}
          </Button>
          {canExport && (
            <>
              <Button
                variant="secondary"
                onClick={() => void download('/exports/orders.csv', 'orders.csv')}
              >
                {t('reports.exportOrders')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void download('/exports/customers.csv', 'customers.csv')}
              >
                {t('reports.exportCustomers')}
              </Button>
            </>
          )}
        </div>
      </Card>

      {canExport && <PdfCard start={draft.aStart} end={draft.aEnd} segment={draft.segment} />}
    </>
  );
}

function PdfCard({ start, end, segment }: { start: string; end: string; segment: string }) {
  const { t } = useTranslation();
  const [sections, setSections] = useState<PdfSection[]>([...PDF_SECTIONS]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: () =>
      apiRequest<{ jobId: string }>('POST', '/reports/pdf', {
        body: { start, end, sections, ...(segment ? { segment } : {}) },
      }),
    onSuccess: (res) => setJobId(res.jobId),
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.network')),
  });
  const job = useQuery({
    queryKey: ['reports', 'pdf', jobId],
    enabled: jobId !== null,
    queryFn: ({ signal }) => apiGet(`/reports/pdf/${jobId}`, { schema: reportJobSchema, signal }),
    refetchInterval: (q) =>
      q.state.data && ['succeeded', 'failed'].includes(q.state.data.status) ? false : 2000,
  });
  const status = job.data?.status;

  return (
    <Card className="mt-6">
      <h2 className="text-sm font-semibold">{t('reports.pdf')}</h2>
      <p className="mb-3 mt-1 text-xs text-ink-muted">{t('reports.pdfHint')}</p>
      <fieldset className="mb-3 flex flex-wrap gap-4">
        <legend className="mb-1 text-sm font-medium">{t('reports.sections')}</legend>
        {PDF_SECTIONS.map((s) => (
          <label key={s} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={sections.includes(s)}
              onChange={(e) =>
                setSections((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))
              }
            />
            {t(`reports.sectionNames.${s}`)}
          </label>
        ))}
      </fieldset>
      {error && (
        <div className="mb-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={
            request.isPending ||
            sections.length === 0 ||
            status === 'pending' ||
            status === 'running'
          }
          onClick={() => {
            setError(null);
            setJobId(null);
            request.mutate();
          }}
        >
          {t('reports.generate')}
        </Button>
        {(status === 'pending' || status === 'running') && (
          <span role="status" className="text-sm text-ink-muted">
            {t('reports.generating')}
          </span>
        )}
        {status === 'succeeded' && (
          <>
            <span role="status" className="text-sm text-positive">
              {t('reports.ready')}
            </span>
            <Button
              variant="secondary"
              onClick={() =>
                void apiDownload(`/reports/pdf/${jobId}/file`, job.data?.fileName ?? 'report.pdf')
              }
            >
              {t('reports.download')}
            </Button>
          </>
        )}
        {status === 'failed' && (
          <Alert tone="error">{t('reports.failed', { reason: job.data?.error ?? '' })}</Alert>
        )}
      </div>
    </Card>
  );
}

import {
  behaviorSeriesQuerySchema,
  cohortsQuerySchema,
  currencyMinorUnits,
  overviewQuerySchema,
  pdfReportRequestSchema,
  valueQuerySchema,
  type ComparisonQuery,
  type ComparisonResponse,
  type ExportableMetric,
  type OverviewQuery,
  type PdfReportRequest,
  type PdfSection,
  type ReportJob,
} from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import type { AuthContext } from '../../core/request-context.js';
import type { Database } from '../../infra/database.js';
import { enqueueJob, type ClaimedJob } from '../../infra/job-queue.js';
import type { FileStorage } from '../../infra/storage.js';
import { recordAudit } from '../audit/audit.service.js';
import type { AnalyticsService } from '../analytics/analytics.service.js';
import type { BehaviorService } from '../analytics/behavior.service.js';
import type { ValueService } from '../analytics/value.service.js';
import type { RecommendationService } from '../recommendations/recommendation.service.js';
import type { SegmentService } from '../segments/segment.service.js';
import { buildReportPdf, type ReportData } from './pdf.js';
import {
  churnTable,
  clvTable,
  cohortsTable,
  compareKpis,
  comparisonTable,
  engagementTable,
  frequencyTable,
  journeyTable,
  kpiTable,
  overviewTable,
  retentionTable,
  type Table,
} from './tables.js';

export const PDF_REPORT_JOB = 'report.pdf';

interface PdfPayload {
  request: PdfReportRequest;
  userId: string;
  role: AuthContext['role'];
}

interface JobRow {
  id: string;
  status: string;
  error: string | null;
  result: unknown;
  created_at: Date;
  finished_at: Date | null;
}

export interface ReportDeps {
  db: Database;
  analytics: AnalyticsService;
  behavior: BehaviorService;
  value: ValueService;
  segments: SegmentService;
  recommendations: RecommendationService;
  storage: FileStorage;
  now?: () => number;
}

/** Comparison report, CSV tables of every analytics chart, and PDF reports (RPT-02 … 05). */
export class ReportService {
  private readonly now: () => number;

  constructor(private readonly deps: ReportDeps) {
    this.now = deps.now ?? Date.now;
  }

  async comparison(auth: AuthContext, q: ComparisonQuery): Promise<ComparisonResponse> {
    const period = (start: string, end: string): OverviewQuery =>
      overviewQuerySchema.parse({ start, end, compare: 'none', segment: q.segment });
    const [a, b] = await Promise.all([
      this.deps.analytics.overview(auth, period(q.aStart, q.aEnd)),
      this.deps.analytics.overview(auth, period(q.bStart, q.bEnd)),
    ]);
    const warnings = new Map(
      [...a.meta.warnings, ...b.meta.warnings].map((w) => [w.code, w] as const),
    );
    return {
      periodA: { start: q.aStart, end: q.aEnd },
      periodB: { start: q.bStart, end: q.bEnd },
      segment: q.segment ?? null,
      currency: a.meta.currency,
      rows: compareKpis(a.data.kpis, b.data.kpis),
      warnings: [...warnings.values()],
    };
  }

  async comparisonTable(auth: AuthContext, q: ComparisonQuery): Promise<Table> {
    const result = await this.comparison(auth, q);
    return comparisonTable(result.rows, result.currency);
  }

  async kpiTable(auth: AuthContext, query: OverviewQuery): Promise<Table> {
    const [overview, definitions] = await Promise.all([
      this.deps.analytics.overview(auth, query),
      this.deps.analytics.definitions().catch(() => ({ data: [] })),
    ]);
    return kpiTable(overview, new Map(definitions.data.map((d) => [d.key, d.name])));
  }

  /** The data behind any analytics chart, with the JSON endpoint's own query parameters. */
  async analyticsTable(
    auth: AuthContext,
    metric: ExportableMetric,
    query: Record<string, unknown>,
  ): Promise<Table> {
    const { analytics, behavior, value } = this.deps;
    switch (metric) {
      case 'overview':
        return overviewTable(await analytics.overview(auth, overviewQuerySchema.parse(query)));
      case 'retention':
        return retentionTable(
          await behavior.retention(auth, behaviorSeriesQuerySchema.parse(query)),
        );
      case 'churn':
        return churnTable(await behavior.churn(auth, behaviorSeriesQuerySchema.parse(query)));
      case 'cohorts':
        return cohortsTable(await behavior.cohorts(auth, cohortsQuerySchema.parse(query)));
      case 'frequency':
        return frequencyTable(await value.frequency(auth, valueQuerySchema.parse(query)));
      case 'clv':
        return clvTable(await value.clv(auth, valueQuerySchema.parse(query)));
      case 'journey':
        return journeyTable(await value.journey(auth, valueQuerySchema.parse(query)));
      case 'engagement':
        return engagementTable(await value.engagement(auth, valueQuerySchema.parse(query)));
    }
  }

  // ───────────── PDF reports (RPT-05) ─────────────

  async requestPdf(auth: AuthContext, input: unknown, ip: string | null): Promise<string> {
    const request = pdfReportRequestSchema.parse(input);
    return this.deps.db.run(auth, async (tx) => {
      const id = await enqueueJob(tx, {
        type: PDF_REPORT_JOB,
        organizationId: auth.organizationId,
        payload: { request, userId: auth.userId, role: auth.role } satisfies PdfPayload,
      });
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'report.pdf',
        entityType: 'job',
        entityId: id ?? undefined,
        details: { start: request.start, end: request.end, segment: request.segment ?? null },
        ip,
      });
      return id!;
    });
  }

  async pdfJob(auth: AuthContext, id: string): Promise<ReportJob & { fileKey: string | null }> {
    // jobs has no RLS (workers see all tenants): the organization filter here is essential.
    const rows = await this.deps.db.run(
      auth,
      (tx) => tx.$queryRaw<JobRow[]>`
        SELECT id, status::text AS status, error, result, created_at, finished_at FROM jobs
        WHERE id = ${id}::uuid AND organization_id = ${auth.organizationId}::uuid
          AND type = ${PDF_REPORT_JOB}`,
    );
    const job = rows[0];
    if (!job) throw new AppError('NOT_FOUND', 'Report not found');
    const result = (job.result ?? {}) as { fileKey?: string; fileName?: string };
    return {
      id: job.id,
      status: job.status.toLowerCase() as ReportJob['status'],
      fileName: result.fileName ?? null,
      fileKey: result.fileKey ?? null,
      error: job.status === 'FAILED' ? (job.error ?? 'Failed') : null,
      createdAt: job.created_at.toISOString(),
      finishedAt: job.finished_at?.toISOString() ?? null,
    };
  }

  /** Job handler: gathers the sections' data, renders the PDF and stores it. */
  async generatePdf(job: ClaimedJob): Promise<void> {
    if (!job.organizationId) throw new Error('report job needs an organization');
    const payload = job.payload as PdfPayload;
    const request = pdfReportRequestSchema.parse(payload.request);
    const auth: AuthContext = {
      userId: payload.userId,
      organizationId: job.organizationId,
      role: payload.role,
    };
    const data = await this.collect(auth, request);
    const pdf = await buildReportPdf(data);
    const fileKey = `reports/${job.organizationId}/${job.id}.pdf`;
    await this.deps.storage.ensureDir(fileKey);
    const out = this.deps.storage.createWriteStream(fileKey);
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      out.end(pdf, () => resolve());
    });
    const fileName = `customer-insights-${request.start}-${request.end}.pdf`;
    await this.deps.db.run(
      auth,
      (tx) =>
        tx.$executeRaw`UPDATE jobs SET result = ${JSON.stringify({ fileKey, fileName, bytes: pdf.length })}::jsonb
        WHERE id = ${job.id}::uuid`,
    );
  }

  private async collect(
    auth: AuthContext,
    request: ReturnType<typeof pdfReportRequestSchema.parse>,
  ): Promise<ReportData> {
    const sections = new Set<PdfSection>(request.sections);
    const { analytics, behavior, segments, recommendations, db } = this.deps;
    const organization = await db.run(auth, (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: auth.organizationId } }),
    );
    const currency = organization.currency.trim();
    const overview = sections.has('overview')
      ? await analytics.overview(
          auth,
          overviewQuerySchema.parse({
            start: request.start,
            end: request.end,
            compare: 'previous_period',
            segment: request.segment,
          }),
        )
      : null;
    const names = sections.has('overview')
      ? new Map(
          (await analytics.definitions().catch(() => ({ data: [] }))).data.map((d) => [
            d.key,
            d.name,
          ]),
        )
      : new Map<string, string>();
    const retention = sections.has('retention')
      ? await behavior.retention(
          auth,
          behaviorSeriesQuerySchema.parse({
            start: request.start,
            end: request.end,
            grain: 'month',
            segment: request.segment,
          }),
        )
      : null;
    const segmentSummary = sections.has('segments') ? await segments.summary(auth) : null;
    const recs = sections.has('recommendations')
      ? await recommendations.list(auth, {
          status: ['open', 'acknowledged'],
          limit: 10,
        })
      : null;
    return {
      organizationName: organization.name,
      currency,
      minorUnits: currencyMinorUnits(currency),
      period: { start: request.start, end: request.end },
      segment: request.segment ?? null,
      generatedAt: new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      sections: request.sections,
      kpis: (overview?.data.kpis ?? []).map((k) => ({
        name: names.get(k.key) ?? k.key,
        unit: k.unit,
        value: k.value,
        previous: k.previous,
        change: k.change,
        changeType: k.changeType,
      })),
      segments: segmentSummary?.segments ?? [],
      retention: (retention?.data.series ?? []).map((p) => ({
        label: p.period.slice(0, 7),
        rate: p.rate,
        base: p.base,
      })),
      recommendations: recs?.data ?? [],
    };
  }
}

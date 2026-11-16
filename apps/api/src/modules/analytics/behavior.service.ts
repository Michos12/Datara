import {
  churnedCustomersInternalSchema,
  churnResponseSchema,
  cohortsResponseSchema,
  retentionResponseSchema,
  type BehaviorSeriesQuery,
  type ChurnedCustomersQuery,
  type ChurnedCustomersResponse,
  type ChurnResponse,
  type CohortsQuery,
  type CohortsResponse,
  type RetentionResponse,
} from '@ci/contracts';
import type { AuthContext } from '../../core/request-context.js';
import type { AnalyticsClient } from '../../infra/analytics-client.js';
import type { Database } from '../../infra/database.js';
import type { SegmentService } from '../segments/segment.service.js';
import { cachedQuery, latestRunId, segmentRunId } from './query-cache.js';

interface CustomerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  external_id: string | null;
  segment_key: string | null;
}

/**
 * Retention, churn and cohort analysis (ANA-01 … 03). Like the overview, a facade: the analytics
 * service computes, this module caches, paginates and adds customer details.
 */
export class BehaviorService {
  constructor(
    private readonly db: Database,
    private readonly client: AnalyticsClient,
    private readonly segments: SegmentService,
  ) {}

  async retention(auth: AuthContext, query: BehaviorSeriesQuery): Promise<RetentionResponse> {
    const params = { ...query, runId: await segmentRunId(this.db, auth, query.segment) };
    return cachedQuery(this.db, auth, 'retention', params, retentionResponseSchema, () =>
      this.client.behavior('retention', auth.organizationId, params),
    );
  }

  async churn(auth: AuthContext, query: BehaviorSeriesQuery): Promise<ChurnResponse> {
    const active = await this.segments.activeConfig(auth);
    const params = { ...query, runId: await segmentRunId(this.db, auth, query.segment) };
    // The by-segment breakdown depends on the active rules: their ID is part of the cache key.
    return cachedQuery(
      this.db,
      auth,
      'churn',
      { ...params, segmentConfigId: active.id },
      churnResponseSchema,
      () =>
        this.client.behavior('churn', auth.organizationId, {
          ...params,
          segmentConfig: active.config,
        }),
    );
  }

  async cohorts(auth: AuthContext, query: CohortsQuery): Promise<CohortsResponse> {
    const params = { ...query, runId: await segmentRunId(this.db, auth, query.segment) };
    return cachedQuery(this.db, auth, 'cohorts', params, cohortsResponseSchema, () =>
      this.client.behavior('cohorts', auth.organizationId, params),
    );
  }

  /** Customers who churned in the period, most valuable first, with offset pagination. */
  async churnedCustomers(
    auth: AuthContext,
    query: ChurnedCustomersQuery,
  ): Promise<ChurnedCustomersResponse> {
    const { limit, cursor, ...range } = query;
    const params = { ...range, runId: await segmentRunId(this.db, auth, range.segment) };
    const all = await cachedQuery(
      this.db,
      auth,
      'churn_customers',
      params,
      churnedCustomersInternalSchema,
      () => this.client.behavior('churn/customers', auth.organizationId, params),
    );
    const offset = cursor ? Number(cursor) : 0;
    const page = all.data.slice(offset, offset + limit);
    const details = await this.db.run(auth, async (tx) => {
      if (page.length === 0) return new Map<string, CustomerRow>();
      const run = await latestRunId(tx, auth.organizationId);
      const ids = page.map((row) => row.customerId);
      const rows = await tx.$queryRaw<CustomerRow[]>`
        SELECT c.id::text AS id, c.first_name, c.last_name, c.email::text AS email, c.external_id,
               m.segment_key
        FROM customers c
        LEFT JOIN analytics_customer_metrics m ON m.customer_id = c.id AND m.run_id = ${run}::uuid
        WHERE c.id = ANY(${ids}::uuid[])`;
      return new Map(rows.map((row) => [row.id, row]));
    });
    const next = offset + limit;
    return {
      meta: all.meta,
      data: page.map((row) => {
        const customer = details.get(row.customerId);
        return {
          ...row,
          firstName: customer?.first_name ?? null,
          lastName: customer?.last_name ?? null,
          email: customer?.email ?? null,
          externalId: customer?.external_id ?? null,
          segment: customer?.segment_key ?? null,
        };
      }),
      page: {
        nextCursor: next < all.data.length ? String(next) : null,
        limit,
        total: all.data.length,
      },
    };
  }
}

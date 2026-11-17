import {
  clvResponseSchema,
  engagementResponseSchema,
  frequencyResponseSchema,
  journeyResponseSchema,
  type ClvResponse,
  type EngagementResponse,
  type FrequencyResponse,
  type JourneyResponse,
  type ValueQuery,
} from '@ci/contracts';
import type { z } from 'zod';
import type { AuthContext } from '../../core/request-context.js';
import type { AnalyticsClient } from '../../infra/analytics-client.js';
import type { Database } from '../../infra/database.js';
import { cachedQuery, latestRunId, segmentRunId } from './query-cache.js';

type Kind = 'frequency' | 'clv' | 'journey' | 'engagement';

/**
 * Customer value analytics (ANA-04 … 07): purchase frequency, historical CLV, journey and
 * engagement. A facade like the overview: Python computes, this module caches.
 */
export class ValueService {
  constructor(
    private readonly db: Database,
    private readonly client: AnalyticsClient,
  ) {}

  frequency(auth: AuthContext, query: ValueQuery): Promise<FrequencyResponse> {
    return this.query(auth, 'frequency', query, frequencyResponseSchema);
  }

  /** CLV by segment reads the latest snapshot even without a segment filter: its run ID is
   * part of the parameters, so a new run never serves an old breakdown. */
  async clv(auth: AuthContext, query: ValueQuery): Promise<ClvResponse> {
    const runId =
      (await segmentRunId(this.db, auth, query.segment)) ??
      (await this.db.run(auth, (tx) => latestRunId(tx, auth.organizationId))) ??
      undefined;
    return this.cached(auth, 'clv', { ...query, runId }, clvResponseSchema);
  }

  journey(auth: AuthContext, query: ValueQuery): Promise<JourneyResponse> {
    return this.query(auth, 'journey', query, journeyResponseSchema);
  }

  engagement(auth: AuthContext, query: ValueQuery): Promise<EngagementResponse> {
    return this.query(auth, 'engagement', query, engagementResponseSchema);
  }

  private async query<T extends { meta: { dataVersion: number } }>(
    auth: AuthContext,
    kind: Kind,
    query: ValueQuery,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const runId = await segmentRunId(this.db, auth, query.segment);
    return this.cached(auth, kind, { ...query, runId }, schema);
  }

  private cached<T extends { meta: { dataVersion: number } }>(
    auth: AuthContext,
    kind: Kind,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return cachedQuery(this.db, auth, kind, params, schema, () =>
      this.client.behavior(kind, auth.organizationId, params),
    );
  }
}

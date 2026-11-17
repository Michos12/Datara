import { AppError } from '../core/errors.js';

export interface OverviewParams {
  start?: string | undefined;
  end?: string | undefined;
  compare: string;
  grain?: string | undefined;
  segment?: string | undefined;
  runId?: string | undefined;
}

/** Client for the internal Python analytics service (docs/04-api-spec.md §2.13). */
export class AnalyticsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** True when the analytics service answers its health check within the timeout. */
  async isHealthy(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await this.fetchImpl(new URL('/internal/health', this.baseUrl), {
        headers: { 'X-Service-Token': this.serviceToken },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  overview(organizationId: string, params: OverviewParams): Promise<unknown> {
    return this.call('POST', '/internal/query/overview', { organizationId, ...params });
  }

  /** Behavior and customer value queries (`/internal/query/<kind>`). */
  behavior(
    kind:
      | 'retention'
      | 'churn'
      | 'churn/customers'
      | 'cohorts'
      | 'frequency'
      | 'clv'
      | 'journey'
      | 'engagement',
    organizationId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return this.call('POST', `/internal/query/${kind}`, { organizationId, ...params });
  }

  segmentPreview(organizationId: string, config: unknown): Promise<unknown> {
    return this.call('POST', '/internal/segments/preview', { organizationId, config });
  }

  definitions(): Promise<unknown> {
    return this.call('GET', '/internal/definitions');
  }

  recommendationRules(): Promise<unknown> {
    return this.call('GET', '/internal/recommendations/rules');
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.baseUrl), {
        method,
        headers: {
          'X-Service-Token': this.serviceToken,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new AppError('ANALYTICS_UNAVAILABLE', 'The analytics service is not reachable');
    }
    if (res.status === 422) {
      throw new AppError('VALIDATION_FAILED', 'The analytics query was rejected');
    }
    if (!res.ok) {
      throw new AppError('ANALYTICS_UNAVAILABLE', `The analytics service answered ${res.status}`);
    }
    return res.json();
  }
}

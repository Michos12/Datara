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
}

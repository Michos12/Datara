import { overviewQuerySchema } from '@ci/contracts';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsClient } from '../src/infra/analytics-client.js';
import { hashParams, splitPending } from '../src/modules/analytics/analytics.service.js';
import { neutralizeFormula } from '../src/modules/exports/export.routes.js';

describe('neutralizeFormula (CSV injection)', () => {
  it.each(['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', '\rx'])('prefixes %j', (value) => {
    expect(neutralizeFormula(value)).toBe(`'${value}`);
  });

  it('leaves ordinary values alone', () => {
    expect(neutralizeFormula('Ana')).toBe('Ana');
    expect(neutralizeFormula('a=b')).toBe('a=b');
    expect(neutralizeFormula('')).toBe('');
  });
});

describe('hashParams', () => {
  it('ignores key order and undefined values', () => {
    expect(hashParams({ start: 'a', end: 'b', grain: undefined })).toBe(
      hashParams({ end: 'b', start: 'a' }),
    );
    expect(hashParams({ start: 'a' })).not.toBe(hashParams({ start: 'b' }));
  });
});

describe('overviewQuerySchema', () => {
  it('defaults the comparison and requires a complete range', () => {
    expect(overviewQuerySchema.parse({})).toEqual({ compare: 'previous_period' });
    expect(overviewQuerySchema.safeParse({ start: '2026-01-01' }).success).toBe(false);
    expect(overviewQuerySchema.safeParse({ start: '2026-02-01', end: '2026-01-01' }).success).toBe(
      false,
    );
  });
});

describe('AnalyticsClient', () => {
  it('posts overview queries with the service token', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const client = new AnalyticsClient('http://analytics:8000', 'token-123', fetchImpl);
    await client.overview('org-1', { start: '2026-01-01', end: '2026-02-01', compare: 'none' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://analytics:8000/internal/query/overview');
    expect(new Headers(init.headers).get('X-Service-Token')).toBe('token-123');
    expect(JSON.parse(String(init.body))).toMatchObject({
      organizationId: 'org-1',
      compare: 'none',
    });
  });

  it('maps network failures and server errors to ANALYTICS_UNAVAILABLE', async () => {
    const down = new AnalyticsClient('http://x', 't', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(down.definitions()).rejects.toMatchObject({ code: 'ANALYTICS_UNAVAILABLE' });
    const broken = new AnalyticsClient(
      'http://x',
      't',
      async () => new Response('', { status: 500 }),
    );
    await expect(broken.definitions()).rejects.toMatchObject({
      code: 'ANALYTICS_UNAVAILABLE',
      status: 503,
    });
  });
});

describe('splitPending', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');

  it('reports running and soon-due recomputes as pending', () => {
    const soon = { run_after: new Date(now + 10 * 60_000), status: 'PENDING' };
    expect(splitPending(soon, now)).toEqual({
      pending: { runAfter: soon.run_after.toISOString() },
      nextRunAt: null,
    });
    const running = { run_after: new Date(now - 60_000), status: 'RUNNING' };
    expect(splitPending(running, now).pending).not.toBeNull();
  });

  it('reports the nightly run as the next scheduled update, not as pending', () => {
    const nightly = { run_after: new Date(now + 19 * 3_600_000), status: 'PENDING' };
    expect(splitPending(nightly, now)).toEqual({
      pending: null,
      nextRunAt: nightly.run_after.toISOString(),
    });
    expect(splitPending(undefined, now)).toEqual({ pending: null, nextRunAt: null });
  });
});

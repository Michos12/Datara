import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadConfig } from '../src/core/config.js';
import { AppError, normalizeError, toProblem } from '../src/core/errors.js';
import { isUuid, newId } from '../src/core/ids.js';
import { AnalyticsClient } from '../src/infra/analytics-client.js';
import { dispatchJob, UnknownJobTypeError } from '../src/infra/job-dispatch.js';
import { retryDelayMs, type ClaimedJob } from '../src/infra/job-queue.js';

const validEnv = {
  DATABASE_URL: 'postgresql://app_user:pw@localhost:5432/customer_insights',
  ANALYTICS_SERVICE_TOKEN: 'a-sufficiently-long-token',
};

describe('loadConfig', () => {
  it('applies defaults and splits CORS origins', () => {
    const config = loadConfig({ ...validEnv, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(config.port).toBe(4000);
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
    expect(config.env).toBe('development');
  });

  it('rejects missing and invalid variables with a readable message', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'mysql://x', ANALYTICS_SERVICE_TOKEN: 'short' }),
    ).toThrow(ConfigError);
    try {
      loadConfig({ DATABASE_URL: 'mysql://x', ANALYTICS_SERVICE_TOKEN: 'short' });
    } catch (err) {
      expect((err as Error).message).toContain('DATABASE_URL');
      expect((err as Error).message).toContain('ANALYTICS_SERVICE_TOKEN');
    }
  });
});

describe('newId', () => {
  it('produces valid, version 7, time-ordered UUIDs', () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_000_001);
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(a[19]);
    expect(a < b).toBe(true);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const id = newId(0x0123456789ab);
    expect(id.startsWith('01234567-89ab-7')).toBe(true);
  });
});

describe('errors', () => {
  it('maps Zod errors to VALIDATION_FAILED with field paths', () => {
    const result = z.object({ email: z.email() }).safeParse({ email: 'nope' });
    const err = normalizeError(result.error);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.status).toBe(422);
    expect(err.fieldErrors?.[0]?.path).toBe('email');
  });

  it('hides internal error messages', () => {
    const err = normalizeError(new Error('password=hunter2 leaked'));
    expect(err.code).toBe('INTERNAL');
    expect(toProblem(err).detail).not.toContain('hunter2');
  });

  it('builds a problem document with a stable type URI', () => {
    const problem = toProblem(new AppError('DUPLICATE_EXTERNAL_ID', 'C-1 exists'), 'req-1');
    expect(problem).toMatchObject({
      type: '/problems/duplicate-external-id',
      status: 409,
      requestId: 'req-1',
    });
  });
});

describe('job queue helpers', () => {
  it('backs off exponentially and caps at one hour', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(480_000);
    expect(retryDelayMs(20)).toBe(3_600_000);
  });

  const job: ClaimedJob = {
    id: newId(),
    organizationId: null,
    type: 'import.process',
    payload: {},
    attempts: 1,
    maxAttempts: 3,
  };
  const logger = pino({ level: 'silent' });

  it('dispatches to the registered handler', async () => {
    const handler = vi.fn(async () => {});
    await dispatchJob(job, { 'import.process': handler }, logger);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('fails jobs with no handler', async () => {
    await expect(dispatchJob(job, {}, logger)).rejects.toBeInstanceOf(UnknownJobTypeError);
  });
});

describe('AnalyticsClient', () => {
  it('sends the service token and reports health', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = new AnalyticsClient('http://analytics:8000', 'token-123', fetchImpl);
    expect(await client.isHealthy()).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://analytics:8000/internal/health');
    expect(new Headers(init.headers).get('X-Service-Token')).toBe('token-123');
  });

  it('reports unhealthy on network errors', async () => {
    const client = new AnalyticsClient('http://analytics:8000', 't', async () => {
      throw new TypeError('fetch failed');
    });
    expect(await client.isHealthy()).toBe(false);
  });
});

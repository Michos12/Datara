import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { deriveEnvironment, loadConfig } from '../src/core/config.js';
import { recordJob, recordRequest, renderMetrics, resetMetrics } from '../src/infra/metrics.js';
import { PassThrough } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { ZipWriter } from '../src/infra/zip.js';
import {
  FixedWindowLimiter,
  SessionPolicy,
  type MembershipGuard,
} from '../src/modules/auth/session-policy.js';
import { testConfig } from './helpers/config.js';

describe('deployment configuration', () => {
  it('derives the runtime database URL from the owner URL and role credentials', () => {
    const env = deriveEnvironment({
      DIRECT_DATABASE_URL: 'postgresql://owner:secret@db.internal:5432/ci?sslmode=require',
      APP_DB_USER: 'app_user',
      APP_DB_PASSWORD: 'p@ss/word',
      ANALYTICS_URL: 'ci-analytics:8000',
    });
    expect(env.DATABASE_URL).toBe(
      'postgresql://app_user:p%40ss%2Fword@db.internal:5432/ci?sslmode=require',
    );
    expect(env.ANALYTICS_URL).toBe('http://ci-analytics:8000');
    // An explicit URL always wins.
    expect(deriveEnvironment({ DATABASE_URL: 'postgresql://x@y/z' }).DATABASE_URL).toBe(
      'postgresql://x@y/z',
    );
  });

  it('defaults to secure cookies and an out-of-process worker in production', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DIRECT_DATABASE_URL: 'postgresql://owner:secret@db:5432/ci',
      APP_DB_USER: 'app_user',
      APP_DB_PASSWORD: 'secret-password',
      ANALYTICS_SERVICE_TOKEN: 'service-token-0123456789',
      JWT_SECRET: 'x'.repeat(48),
    });
    expect(config.auth.cookieSecure).toBe(true);
    expect(config.workerInProcess).toBe(false);
    expect(config.metricsToken).toBeNull();
    expect(config.databaseUrl).toContain('app_user');
  });
});

describe('metrics', () => {
  it('renders histograms, counters and gauges in Prometheus format', () => {
    resetMetrics();
    recordRequest('GET', '/api/v1/customers/:id', 200, 0.12);
    recordRequest('GET', '/api/v1/customers/:id', 200, 0.4);
    recordJob('report.pdf', 'succeeded', 2);
    recordJob('report.pdf', 'failed', 0);
    const text = renderMetrics([{ name: 'jobs_due', help: 'Due.', value: 3 }]);
    expect(text).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/api/v1/customers/:id",status="2xx",le="0.3"} 1',
    );
    expect(text).toContain(
      'http_request_duration_seconds_count{method="GET",route="/api/v1/customers/:id",status="2xx"} 2',
    );
    expect(text).toContain('jobs_total{type="report.pdf",outcome="failed"} 1');
    expect(text).toContain('# TYPE jobs_due gauge\njobs_due 3');
  });

  it('protects the endpoint with a bearer token and labels requests by route template', async () => {
    resetMetrics();
    const app = createApp({
      config: testConfig({ metricsToken: 'metrics-token-0123456789' }),
      logger: pino({ level: 'silent' }),
      health: {
        database: async () => true,
        migrations: async () => true,
        analytics: async () => true,
      },
    });
    await request(app).get('/api/v1/health');
    expect((await request(app).get('/api/v1/metrics')).status).toBe(401);
    const res = await request(app)
      .get('/api/v1/metrics')
      .set('Authorization', 'Bearer metrics-token-0123456789');
    expect(res.status).toBe(200);
    expect(res.text).toContain('route="/api/v1/health"');
  });
});

describe('zip', () => {
  it('streams a valid archive with UTF-8 names', async () => {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    const writer = new ZipWriter(out);
    async function* pieces() {
      yield Buffer.from('x,y\r\n');
      yield Buffer.from('1,2\r\n');
    }
    await writer.add('a.csv', pieces());
    await writer.add('ñ.txt', [Buffer.from('hola')]);
    const total = await writer.finish();
    const zip = Buffer.concat(chunks);
    expect(zip.length).toBe(total);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    // First central entry: compressed size, then the data right after the local header.
    const central = zip.readUInt32LE(end + 16);
    const compressed = zip.readUInt32LE(central + 20);
    expect(zip.readUInt32LE(central + 24)).toBe(10);
    const data = zip.subarray(30 + 5, 30 + 5 + compressed);
    expect(inflateRawSync(data).toString()).toBe('x,y\r\n1,2\r\n');
    expect(zip.includes(Buffer.from('ñ.txt'))).toBe(true);
  });
});

describe('session policy', () => {
  it('counts hits per key in fixed windows', () => {
    let now = 60_000;
    const limiter = new FixedWindowLimiter(2, 60_000, () => now);
    expect(limiter.hit('a')).toBeNull();
    expect(limiter.hit('a')).toBeNull();
    expect(limiter.hit('b')).toBeNull();
    now += 15_000;
    expect(limiter.hit('a')).toBe(45);
    now += 45_000;
    expect(limiter.hit('a')).toBeNull();
  });

  it('rejects former members and uses the current role', async () => {
    const roles = new Map([['u1|o1', 'VIEWER' as const]]);
    const guard = {
      role: async (u: string, o: string) => roles.get(`${u}|${o}`) ?? null,
    } as unknown as MembershipGuard;
    const policy = new SessionPolicy(guard, {
      requestsPerUserPerMinute: 1,
      expensivePerOrgPerMinute: 1,
    });
    const res = { setHeader: () => undefined } as never;
    const admitted = await policy.admit(res, { userId: 'u1', organizationId: 'o1', role: 'OWNER' });
    expect(admitted.role).toBe('VIEWER');
    await expect(
      policy.admit(res, { userId: 'u2', organizationId: 'o1', role: 'OWNER' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      policy.admit(res, { userId: 'u1', organizationId: 'o1', role: 'OWNER' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    policy.expensive(res, 'o1');
    expect(() => policy.expensive(res, 'o1')).toThrow(/Too many exports/);
  });
});

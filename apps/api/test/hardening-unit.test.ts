import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { deriveEnvironment, loadConfig } from '../src/core/config.js';
import { recordJob, recordRequest, renderMetrics, resetMetrics } from '../src/infra/metrics.js';
import { createZip } from '../src/infra/zip.js';
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
  it('writes a valid archive with UTF-8 names', () => {
    const zip = createZip([
      { name: 'a.csv', data: Buffer.from('x,y\r\n1,2\r\n') },
      { name: 'ñ.txt', data: Buffer.from('hola') },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    expect(zip.includes(Buffer.from('ñ.txt'))).toBe(true);
  });
});

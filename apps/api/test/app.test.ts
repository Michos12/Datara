import { problemSchema, readinessResponseSchema } from '@ci/contracts';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { HealthChecks } from '../src/modules/health/health.routes.js';

const up = async () => true;
const down = async () => false;
const boom = async (): Promise<boolean> => {
  throw new Error('connection refused');
};

function buildApp(health: Partial<HealthChecks> = {}) {
  return createApp({
    config: { corsOrigins: ['http://localhost:5173'], version: '1.2.3' },
    logger: pino({ level: 'silent' }),
    health: { database: up, migrations: up, analytics: up, ...health },
  });
}

describe('GET /api/v1/health', () => {
  it('returns ok with the service version', async () => {
    const res = await request(buildApp()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'api', version: '1.2.3' });
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(buildApp()).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('GET /api/v1/ready', () => {
  it('is ready when database and migrations are up', async () => {
    const res = await request(buildApp()).get('/api/v1/ready');
    expect(res.status).toBe(200);
    expect(readinessResponseSchema.parse(res.body)).toEqual({
      status: 'ready',
      checks: { database: 'up', migrations: 'up', analytics: 'up' },
    });
  });

  it('stays ready when only analytics is down', async () => {
    const res = await request(buildApp({ analytics: down })).get('/api/v1/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.analytics).toBe('down');
  });

  it('is not ready when the database check throws', async () => {
    const res = await request(buildApp({ database: boom })).get('/api/v1/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'not_ready', checks: { database: 'down' } });
  });

  it('is not ready when migrations are not applied', async () => {
    const res = await request(buildApp({ migrations: down })).get('/api/v1/ready');
    expect(res.status).toBe(503);
  });
});

describe('errors', () => {
  it('returns RFC 9457 problem details for unknown routes', async () => {
    const res = await request(buildApp()).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const problem = problemSchema.parse(res.body);
    expect(problem.code).toBe('NOT_FOUND');
    expect(problem.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(buildApp())
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

describe('request IDs', () => {
  it('echoes a well-formed incoming request ID', async () => {
    const res = await request(buildApp()).get('/api/v1/health').set('X-Request-Id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('replaces a malformed incoming request ID', async () => {
    const res = await request(buildApp())
      .get('/api/v1/health')
      .set('X-Request-Id', 'not valid <script>');
    expect(res.headers['x-request-id']).not.toBe('not valid <script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

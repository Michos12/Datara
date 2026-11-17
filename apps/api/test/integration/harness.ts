import type { AuthResponse, SignupRequest } from '@ci/contracts';
import type { Express } from 'express';
import { pino } from 'pino';
import request, { type Response } from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { newId } from '../../src/core/ids.js';
import type { AnalyticsClient } from '../../src/infra/analytics-client.js';
import { Database } from '../../src/infra/database.js';
import { dispatchJob, NODE_JOB_PREFIXES } from '../../src/infra/job-dispatch.js';
import { claimJob, completeJob, failJob } from '../../src/infra/job-queue.js';
import { FileStorage } from '../../src/infra/storage.js';
import { importJobHandlers } from '../../src/modules/imports/import.jobs.js';
import { createPrismaClient, type PrismaClient } from '../../src/infra/prisma.js';
import type { AuthRateLimits } from '../../src/modules/auth/rate-limits.js';
import { testConfig } from '../helpers/config.js';

export const API = '/api/v1';

const GENEROUS_LIMITS: AuthRateLimits = {
  loginFailuresPerMinute: 1000,
  authRequestsPerMinute: 1000,
  refreshPerMinute: 1000,
};

export interface TestContext {
  app: Express;
  db: Database;
  /** Owner connection: bypasses RLS. Only for arranging state the API cannot create yet. */
  owner: PrismaClient;
  /** Moves the injectable clock forward. */
  advance(ms: number): void;
  /** Runs queued Node jobs (imports) until none are left, like the worker would. */
  runJobs(): Promise<number>;
  close(): Promise<void>;
}

export function createTestContext(
  options: { rateLimits?: AuthRateLimits; analytics?: AnalyticsClient } = {},
): TestContext {
  const prisma = createPrismaClient(inject('databaseUrl'));
  const owner = createPrismaClient(inject('ownerDatabaseUrl'));
  const db = new Database(prisma);
  const storage = new FileStorage(inject('storageDir'));
  let offset = 0;
  const now = () => Date.now() + offset;
  const handlers = importJobHandlers({ db, storage, now });
  const silent = pino({ level: 'silent' });
  const app = createApp({
    config: testConfig({ databaseUrl: inject('databaseUrl') }),
    logger: pino({ level: 'silent' }),
    health: {
      database: async () => true,
      migrations: async () => true,
      analytics: async () => true,
    },
    database: db,
    rateLimits: options.rateLimits ?? GENEROUS_LIMITS,
    now,
    storage,
    ...(options.analytics ? { analytics: options.analytics } : {}),
  });
  return {
    app,
    db,
    owner,
    advance: (ms) => {
      offset += ms;
    },
    runJobs: async () => {
      let processed = 0;
      for (;;) {
        const job = await claimJob(prisma, 'test-worker', NODE_JOB_PREFIXES);
        if (!job) return processed;
        try {
          await dispatchJob(job, handlers, silent);
          await completeJob(prisma, job.id);
        } catch (err) {
          await failJob(prisma, job, String(err));
        }
        processed++;
      }
    },
    close: async () => {
      await prisma.$disconnect();
      await owner.$disconnect();
    },
  };
}

/** name → value from Set-Cookie headers. */
export function cookiesOf(res: Response): Record<string, string> {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const out: Record<string, string> = {};
  for (const line of raw ?? []) {
    const [pair] = line.split(';');
    const index = pair!.indexOf('=');
    out[pair!.slice(0, index)] = decodeURIComponent(pair!.slice(index + 1));
  }
  return out;
}

export function rawSetCookies(res: Response): string[] {
  return (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
}

export interface TestSession {
  email: string;
  password: string;
  accessToken: string;
  refresh: string;
  csrf: string;
  body: AuthResponse;
}

export function signupBody(overrides: Partial<SignupRequest> = {}): SignupRequest {
  return {
    email: `user-${newId()}@example.com`,
    password: 'correct horse battery staple',
    fullName: 'Test User',
    organization: {
      name: 'Test Org',
      timezone: 'America/Bogota',
      currency: 'USD',
      industry: 'restaurant',
    },
    ...overrides,
  };
}

export async function signup(
  app: Express,
  overrides: Partial<SignupRequest> = {},
): Promise<TestSession> {
  const body = signupBody(overrides);
  const res = await request(app).post(`${API}/auth/signup`).send(body);
  if (res.status !== 201)
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookies = cookiesOf(res);
  return {
    email: body.email,
    password: body.password,
    accessToken: res.body.accessToken,
    refresh: cookies.ci_refresh!,
    csrf: cookies.ci_csrf!,
    body: res.body,
  };
}

export function refreshRequest(app: Express, session: { refresh: string; csrf: string }) {
  return request(app)
    .post(`${API}/auth/refresh`)
    .set('Cookie', [`ci_refresh=${session.refresh}`, `ci_csrf=${session.csrf}`])
    .set('X-CSRF-Token', session.csrf);
}

export function authed(app: Express, accessToken: string) {
  return {
    get: (path: string) =>
      request(app).get(`${API}${path}`).set('Authorization', `Bearer ${accessToken}`),
    post: (path: string, body?: object) =>
      request(app).post(`${API}${path}`).set('Authorization', `Bearer ${accessToken}`).send(body),
    put: (path: string, body: object) =>
      request(app).put(`${API}${path}`).set('Authorization', `Bearer ${accessToken}`).send(body),
    delete: (path: string) =>
      request(app).delete(`${API}${path}`).set('Authorization', `Bearer ${accessToken}`),
    upload: (entity: 'customers' | 'orders' | 'interactions', csv: string, filename = 'data.csv') =>
      request(app)
        .post(`${API}/imports?entity=${entity}&filename=${encodeURIComponent(filename)}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Content-Type', 'text/csv')
        .send(csv),
    patch: (path: string, body: object) =>
      request(app).patch(`${API}${path}`).set('Authorization', `Bearer ${accessToken}`).send(body),
  };
}

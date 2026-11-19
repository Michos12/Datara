import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './core/config.js';
import { errorHandler, notFoundHandler } from './core/errors.js';
import type { Logger } from './core/logger.js';
import { AnalyticsClient } from './infra/analytics-client.js';
import type { Database } from './infra/database.js';
import { createMailer, type Mailer } from './infra/mailer.js';
import { TeamService } from './modules/organizations/team.service.js';
import { reportRouter } from './modules/reports/report.routes.js';
import { ReportService } from './modules/reports/report.service.js';
import { FileStorage } from './infra/storage.js';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { AnalyticsService } from './modules/analytics/analytics.service.js';
import { BehaviorService } from './modules/analytics/behavior.service.js';
import { ValueService } from './modules/analytics/value.service.js';
import { recommendationRouter } from './modules/recommendations/recommendation.routes.js';
import { RecommendationService } from './modules/recommendations/recommendation.service.js';
import { interactionRouter } from './modules/interactions/interaction.routes.js';
import { InteractionService } from './modules/interactions/interaction.service.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { AuthService } from './modules/auth/auth.service.js';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from './modules/auth/rate-limits.js';
import { TokenService } from './modules/auth/tokens.js';
import { healthRouter, type HealthChecks } from './modules/health/health.routes.js';
import { customerDataRouter } from './modules/customers/customer.routes.js';
import { CustomerService } from './modules/customers/customer.service.js';
import { exportRouter } from './modules/exports/export.routes.js';
import { importRouter } from './modules/imports/import.routes.js';
import { ImportService } from './modules/imports/import.service.js';
import { jobRouter } from './modules/jobs/job.routes.js';
import { OrderService } from './modules/orders/order.service.js';
import { segmentRouter } from './modules/segments/segment.routes.js';
import { SegmentService } from './modules/segments/segment.service.js';
import { organizationRouter } from './modules/organizations/organization.routes.js';
import { OrganizationService } from './modules/organizations/organization.service.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  health: HealthChecks;
  /** Omitted in tests that only exercise the HTTP shell (health, errors). */
  database?: Database;
  rateLimits?: AuthRateLimits;
  /** Clock for token issuing and expiry; injectable for tests. */
  now?: () => number;
  /** Upload storage; defaults to config.storageDir on local disk. */
  storage?: FileStorage;
  /** Client for the internal analytics service; defaults to config.analytics. */
  analytics?: AnalyticsClient;
  /** Outgoing email; defaults to SMTP from config (or a log-only mailer). */
  mailer?: Mailer;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Builds the Express app. Dependencies are injected so tests control the database and clock. */
export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      // Accept a well-formed upstream request ID, otherwise mint one; echo it back.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const v1 = express.Router();
  v1.use(healthRouter(deps.health, config.version));

  if (deps.database) {
    const tokens = new TokenService(config.auth, deps.now);
    const mail = {
      mailer: deps.mailer ?? createMailer(config, logger),
      appUrl: config.appUrl,
      logger,
    };
    const auth = new AuthService(deps.database, tokens, deps.now, mail);
    v1.use(
      authRouter({
        auth,
        tokens,
        cookies: {
          secure: config.auth.cookieSecure,
          refreshTtlMs: tokens.refreshTokenTtlMs,
        },
        rateLimits: deps.rateLimits ?? DEFAULT_AUTH_RATE_LIMITS,
      }),
    );
    v1.use(
      organizationRouter({
        organizations: new OrganizationService(deps.database),
        team: new TeamService(deps.database, mail, deps.now),
        tokens,
      }),
    );
    const orders = new OrderService(deps.database, deps.now);
    v1.use(
      customerDataRouter({
        customers: new CustomerService(deps.database, deps.now),
        orders,
        tokens,
      }),
    );
    v1.use(
      interactionRouter({ interactions: new InteractionService(deps.database, deps.now), tokens }),
    );
    const storage = deps.storage ?? new FileStorage(config.storageDir);
    v1.use(importRouter({ imports: new ImportService(deps.database, storage), tokens }));
    v1.use(jobRouter({ db: deps.database, tokens }));
    const analyticsClient =
      deps.analytics ?? new AnalyticsClient(config.analytics.url, config.analytics.serviceToken);
    const segments = new SegmentService(deps.database, analyticsClient);
    const analytics = new AnalyticsService(deps.database, analyticsClient, deps.now);
    const behavior = new BehaviorService(deps.database, analyticsClient, segments);
    const value = new ValueService(deps.database, analyticsClient);
    v1.use(analyticsRouter({ analytics, behavior, value, tokens }));
    v1.use(segmentRouter({ segments, tokens }));
    const recommendations = new RecommendationService(deps.database, analyticsClient, deps.now);
    v1.use(recommendationRouter({ recommendations, db: deps.database, tokens }));
    const reports = new ReportService({
      db: deps.database,
      analytics,
      behavior,
      value,
      segments,
      recommendations,
      storage,
      ...(deps.now ? { now: deps.now } : {}),
    });
    v1.use(reportRouter({ reports, orders, db: deps.database, storage, tokens }));
    v1.use(exportRouter({ db: deps.database, tokens, ...(deps.now ? { now: deps.now } : {}) }));
  }

  app.use('/api/v1', v1);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './core/config.js';
import { errorHandler, notFoundHandler } from './core/errors.js';
import type { Logger } from './core/logger.js';
import type { Database } from './infra/database.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { AuthService } from './modules/auth/auth.service.js';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from './modules/auth/rate-limits.js';
import { TokenService } from './modules/auth/tokens.js';
import { healthRouter, type HealthChecks } from './modules/health/health.routes.js';
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
    const auth = new AuthService(deps.database, tokens, deps.now);
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
    v1.use(organizationRouter({ organizations: new OrganizationService(deps.database), tokens }));
  }

  app.use('/api/v1', v1);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

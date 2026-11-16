import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './core/config.js';
import { errorHandler, notFoundHandler } from './core/errors.js';
import type { Logger } from './core/logger.js';
import { healthRouter, type HealthChecks } from './modules/health/health.routes.js';

export interface AppDeps {
  config: Pick<Config, 'corsOrigins' | 'version'>;
  logger: Logger;
  health: HealthChecks;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Builds the Express app. Dependencies are injected so tests can run without a database. */
export function createApp({ config, logger, health }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

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

  const v1 = express.Router();
  v1.use(healthRouter(health, config.version));
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

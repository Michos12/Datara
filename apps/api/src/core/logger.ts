import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

/**
 * Structured JSON logger. Request logs carry requestId and (from M1) organizationId,
 * never personal data: auth headers and cookies are redacted.
 */
export function createLogger(config: Pick<Config, 'logLevel' | 'env' | 'version'>): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'api', version: config.version },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
    ...(config.env === 'development'
      ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
      : {}),
  });
}

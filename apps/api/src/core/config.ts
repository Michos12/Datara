import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().default('0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  ANALYTICS_URL: z.url().default('http://localhost:8000'),
  ANALYTICS_SERVICE_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /** Secure cookies need HTTPS. Defaults to true in production. */
  COOKIE_SECURE: booleanString.optional(),
  /** Express "trust proxy" setting: false, true, a hop count, or e.g. "loopback". */
  TRUST_PROXY: z.string().default('false'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  /** Directory for uploads and generated files; a shared volume in Docker. */
  STORAGE_DIR: z.string().min(1).default('storage'),
  /** Outgoing mail server, e.g. smtp://mailpit:1025. Unset: emails are only logged (dev). */
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  MAIL_FROM: z.string().min(3).default('Customer Insights <no-reply@customer-insights.local>'),
  /** Public URL of the web app, for links in emails. */
  APP_URL: z.url().default('http://localhost:5173'),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  version: string;
  port: number;
  databaseUrl: string;
  analytics: { url: string; serviceToken: string };
  auth: {
    jwtSecret: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlDays: number;
    cookieSecure: boolean;
  };
  trustProxy: boolean | number | string;
  corsOrigins: string[];
  logLevel: (typeof logLevels)[number];
  storageDir: string;
  mail: { smtpUrl: string | null; from: string };
  appUrl: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/** Validates environment variables once at startup; the process refuses to start on bad config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }
  const e = result.data;
  return {
    env: e.NODE_ENV,
    version: e.APP_VERSION,
    port: e.API_PORT,
    databaseUrl: e.DATABASE_URL,
    analytics: { url: e.ANALYTICS_URL, serviceToken: e.ANALYTICS_SERVICE_TOKEN },
    auth: {
      jwtSecret: e.JWT_SECRET,
      accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
      cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    },
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    corsOrigins: e.CORS_ORIGINS,
    logLevel: e.LOG_LEVEL,
    storageDir: e.STORAGE_DIR,
    mail: { smtpUrl: e.SMTP_URL ?? null, from: e.MAIL_FROM },
    appUrl: e.APP_URL.replace(/\/+$/, ''),
  };
}

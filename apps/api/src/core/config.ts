import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().default('0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  ANALYTICS_URL: z.url().default('http://localhost:8000'),
  ANALYTICS_SERVICE_TOKEN: z.string().min(16, 'must be at least 16 characters'),
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
});

export interface Config {
  env: 'development' | 'test' | 'production';
  version: string;
  port: number;
  databaseUrl: string;
  analytics: { url: string; serviceToken: string };
  corsOrigins: string[];
  logLevel: (typeof logLevels)[number];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
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
    corsOrigins: e.CORS_ORIGINS,
    logLevel: e.LOG_LEVEL,
  };
}

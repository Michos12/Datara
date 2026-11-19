import type { Config } from '../../src/core/config.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: 'test',
    version: '1.2.3',
    port: 0,
    databaseUrl: 'postgresql://app_user:pw@localhost:5432/unused',
    analytics: { url: 'http://localhost:8000', serviceToken: 'test-service-token-123' },
    auth: {
      jwtSecret: 'test-jwt-secret-that-is-long-enough-1234',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 14,
      cookieSecure: false,
    },
    trustProxy: false,
    corsOrigins: ['http://localhost:5173'],
    logLevel: 'silent',
    storageDir: 'storage-test',
    mail: { smtpUrl: null, from: 'Customer Insights <test@example.com>' },
    appUrl: 'http://app.test',
    ...overrides,
  };
}

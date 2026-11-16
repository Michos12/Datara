import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Runtime role (app_user) on the throwaway database: subject to RLS. */
    databaseUrl: string;
    /** Owner role on the throwaway database: bypasses RLS, for test arrangement only. */
    ownerDatabaseUrl: string;
  }
}

const apiDir = fileURLToPath(new URL('../..', import.meta.url));
const rootEnv = fileURLToPath(new URL('../../../../.env', import.meta.url));

function withDatabase(
  url: string,
  database: string,
  credentials?: { user: string; password: string },
) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (credentials) {
    parsed.username = encodeURIComponent(credentials.user);
    parsed.password = encodeURIComponent(credentials.password);
  }
  return parsed.toString();
}

/**
 * Creates a fresh database for this test run, applies all migrations as the owner (exactly as
 * production does), and hands tests an app_user connection string so RLS is enforced.
 * Requires a running Postgres: `docker compose up -d db` locally, a service container in CI.
 */
export default async function setup(project: TestProject) {
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const ownerUrl = process.env.TEST_DIRECT_DATABASE_URL ?? process.env.DIRECT_DATABASE_URL;
  if (!ownerUrl) {
    throw new Error(
      'Integration tests need DIRECT_DATABASE_URL (schema owner). Start Postgres with `docker compose up -d db`.',
    );
  }
  const appUser = process.env.APP_DB_USER ?? 'app_user';
  const appPassword = process.env.APP_DB_PASSWORD ?? 'change-me-app';
  const database = `ci_test_${Date.now()}_${process.pid}`;

  const admin = new pg.Client({ connectionString: ownerUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();

  const testOwnerUrl = withDatabase(ownerUrl, database);
  const owner = new pg.Client({ connectionString: testOwnerUrl });
  await owner.connect();
  // Same grants as infra/postgres/init/01-app-role.sh; default privileges are per database.
  await owner.query(`
    GRANT CONNECT ON DATABASE "${database}" TO "${appUser}";
    GRANT USAGE ON SCHEMA public TO "${appUser}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${appUser}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${appUser}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "${appUser}";
  `);
  await owner.end();

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: apiDir,
    env: { ...process.env, DIRECT_DATABASE_URL: testOwnerUrl },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  project.provide(
    'databaseUrl',
    withDatabase(ownerUrl, database, { user: appUser, password: appPassword }),
  );
  project.provide('ownerDatabaseUrl', testOwnerUrl);

  return async () => {
    const cleanup = new pg.Client({ connectionString: ownerUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await cleanup.end();
  };
}

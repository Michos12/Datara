import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// Prisma CLI does not load .env files itself. Load the repository root .env when present
// (local development); in Docker and CI the variables come from the environment.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  engine: 'classic',
  datasource: {
    // Migrations run as the schema owner. The runtime connection (app_user, subject to
    // row-level security) is configured in src/infra/prisma.ts via DATABASE_URL.
    url: process.env.DIRECT_DATABASE_URL ?? 'postgresql://placeholder@localhost:5432/placeholder',
  },
});

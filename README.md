# Customer Insights

Customer analytics and business intelligence SaaS for small and medium-sized businesses. It
turns customer and order data into documented metrics: retention, churn, cohorts, RFM
segments, customer lifetime value, and rule-based recommendations.

> **Status:** Milestones **M0 (foundations)** and **M1 (auth, organizations, tenant isolation)**
> are done: sign up, sign in, organization settings, audit log, and row-level security on every
> tenant table. Customer data arrives in M2. See the [roadmap](docs/06-roadmap.md).

## Architecture at a glance

| Component    | Path                 | Stack                                                       |
| ------------ | -------------------- | ----------------------------------------------------------- |
| Web app      | `apps/web`           | React 19, TypeScript, Tailwind CSS 4, ECharts 6, Vite 8     |
| API + worker | `apps/api`           | Node.js, Express 5, TypeScript, Prisma 7                    |
| Analytics    | `services/analytics` | Python, FastAPI (internal only), Pandas, NumPy, psycopg 3   |
| Contracts    | `packages/contracts` | Zod schemas shared by API and web                           |
| Database     | Docker `db`          | PostgreSQL 17 (data, analytics snapshots and the job queue) |

Design documents live in [`docs/`](docs/README.md), decisions in [`docs/adr/`](docs/adr/README.md).

## Quick start (Docker)

Requirements: Docker Desktop (or Docker Engine with Compose v2.22+).

```bash
cp .env.example .env
```

```bash
docker compose up --build --watch
```

Then open:

- Web app: http://localhost:5173
- API health: http://localhost:4000/api/v1/health
- API readiness (database, migrations, analytics): http://localhost:4000/api/v1/ready

`--watch` syncs source changes into the containers for hot reload. The `migrate` service applies
Prisma migrations as the schema owner before the API starts. The API and analytics service
connect as `app_user`, which is subject to row-level security.

To reset the database: `docker compose down -v`.

## Local development without Docker for the apps

Run only Postgres in Docker and the apps on your machine (Node 22+, [uv](https://docs.astral.sh/uv/)).

```bash
docker compose up -d db
```

```bash
npm install
```

```bash
npm run db:migrate -w @ci/api
```

```bash
npm run dev:api
```

```bash
npm run dev:web
```

```bash
cd services/analytics && uv sync && uv run uvicorn insights.api.main:app --reload --env-file ../../.env
```

The API and Prisma CLI read the root `.env` automatically.

## Checks

| What                     | Command                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Lint (TS)                | `npm run lint`                                                                           |
| Format check             | `npm run format:check`                                                                   |
| Typecheck                | `npm run typecheck`                                                                      |
| Tests (TS)               | `npm test`                                                                               |
| API integration tests    | `npm run test:integration -w @ci/api` (needs Postgres: `docker compose up -d db`)        |
| Build                    | `npm run build`                                                                          |
| Analytics lint/type/test | `cd services/analytics && uv run ruff check . && uv run mypy && uv run python -m pytest` |

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of these, applies the
migrations to a clean Postgres, and builds every Docker image.

## Repository layout

```
apps/
  api/                 Express API, Node job worker, Prisma schema and migrations
  web/                 React SPA
packages/
  contracts/           Shared Zod schemas (API contract)
services/
  analytics/           Python analytics service and worker
infra/postgres/init/   Database bootstrap (runtime role)
docs/                  SRS, architecture, data model, API, methodology, roadmap, ADRs
```

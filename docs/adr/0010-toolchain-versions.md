# ADR-0010: Toolchain baseline

- **Status:** Accepted (2026-11-16)

## Context

Starting a project on an old major version means an avoidable migration later, but each new
major has to be verified before it is relied on.

## Decision

| Area      | Choice                                                                                      | Note                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime   | Node 24 LTS in containers (`.nvmrc`); Python 3.13 in containers                             | Local development also works on Node 26 and Python 3.14.                                                                                                    |
| ORM       | **Prisma 7** with the `prisma-client` generator and the `@prisma/adapter-pg` driver adapter | URLs live in `prisma.config.ts` (migrations, owner role) and `src/infra/prisma.ts` (runtime, `app_user`). Prisma 6 had a high-severity advisory in its CLI. |
| Testing   | **Vitest 5**                                                                                | Vitest 3 pulled in a critical tinypool advisory.                                                                                                            |
| Frontend  | React 19, React Router 8 (data router), TanStack Query 5, Tailwind CSS 4, Vite 8, ECharts 6 | ECharts is tree-shaken and the Overview route is lazy-loaded.                                                                                               |
| Logging   | pino 10 / pino-http 11; structlog in Python                                                 |                                                                                                                                                             |
| Kept back | TypeScript 5.9 (not 7), ESLint 9 (not 10), tsup 8                                           | TypeScript 7 is the new native compiler and typescript-eslint support is unverified. Revisit after M1.                                                      |

## Consequences

- `npm audit` reports remaining moderate and dev-only advisories (esbuild dev server, minimatch).
  None are in production runtime dependencies; they are re-checked at each milestone.
- The Starlette TestClient deprecation warning for `httpx` is filtered in pytest until its
  suggested replacement package is vetted.

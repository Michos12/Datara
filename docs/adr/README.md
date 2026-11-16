# Architecture Decision Records

Short records of significant decisions: context, the decision, and its consequences. A
superseded ADR is kept and marked as such; new ADRs get the next number.

| #                                             | Decision                                                     | Status   |
| --------------------------------------------- | ------------------------------------------------------------ | -------- |
| [0001](0001-modular-monolith.md)              | Modular monolith with a separate analytics process           | Accepted |
| [0002](0002-python-analytics-service.md)      | Analytics in a Python service, not in the Node API           | Accepted |
| [0003](0003-postgres-job-queue.md)            | PostgreSQL as the job queue                                  | Accepted |
| [0004](0004-tenant-isolation.md)              | Shared-schema multi-tenancy with app scoping and RLS         | Accepted |
| [0005](0005-prisma-owns-migrations.md)        | Prisma owns all migrations; Python uses plain SQL            | Accepted |
| [0006](0006-rest-contracts-zod.md)            | REST API with shared Zod contracts                           | Accepted |
| [0007](0007-own-auth-jwt.md)                  | Own email/password auth with JWT and rotating refresh tokens | Accepted |
| [0008](0008-monorepo-npm-workspaces.md)       | Monorepo with npm workspaces                                 | Accepted |
| [0009](0009-snapshots-and-versioned-cache.md) | Precomputed snapshots plus a data-versioned query cache      | Accepted |
| [0010](0010-toolchain-versions.md)            | Toolchain baseline (Prisma 7, Vite 8, React Router 8, ...)   | Accepted |
| [0011](0011-currency-minor-units.md)          | Money in ISO 4217 minor units, one table shared by all code  | Accepted |

Design context for all of these: [../02-architecture.md](../02-architecture.md).

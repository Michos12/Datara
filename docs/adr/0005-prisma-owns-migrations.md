# ADR-0005: Prisma owns all migrations; Python uses plain SQL

- **Status:** Accepted (2026-11-16)

## Context

Two services in two languages write to one database. Two migration tools on one schema would
conflict.

## Decision

`apps/api/prisma/schema.prisma` and `apps/api/prisma/migrations` are the single source of truth
for every table, including the `analytics_*` tables the Python service writes. Anything Prisma
cannot express (RLS policies, generated columns, partial indexes, CHECK constraints, SQL
functions) goes into hand-written SQL in the same migration files. The Python service uses
psycopg 3 with parameterized SQL and never runs DDL.

## Consequences

- One migration history; CI applies all migrations to a clean database.
- Python has no ORM models. Integration tests against the migrated schema catch mismatches.
- Hand-written SQL in migrations is invisible to `prisma migrate diff`, so schema drift checks
  must account for it.

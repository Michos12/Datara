# ADR-0004: Shared-schema multi-tenancy with app scoping and RLS

- **Status:** Accepted (2026-11-16). Foundations in M0; policies applied per table from M1.

## Context

Many SMB tenants share the platform. A cross-tenant data leak is the most damaging possible
defect. Schema-per-tenant or database-per-tenant isolation is too expensive at SMB prices.

## Decision

One database and schema; every tenant-owned table has `organization_id`. Isolation is enforced
twice:

1. **Application:** a tenant-scoped Prisma client (M1) injects `organization_id` into every
   query. ESLint forbids importing the raw Prisma client outside `src/infra` and
   `src/modules/auth`. Records in another tenant return 404.
2. **Database:** row-level security policies use `app_current_org()`, which reads the
   transaction-local setting `app.org_id`. The app connects as `app_user` (`NOBYPASSRLS`, not
   the table owner); migrations run as the owner. An unset setting matches no rows.

`withTenant()` (Node) and `Database.tenant_transaction()` (Python) set the context with
`set_config('app.org_id', …, true)` inside a transaction, so pooled connections never leak it.

## Consequences

- Each request runs in a transaction: one extra round trip.
- A cross-tenant test suite (from M1) must cover every endpoint, plus a test that RLS alone
  blocks access when application scoping is bypassed.
- The `jobs` table has no RLS (workers must see all pending jobs); handlers set the tenant
  context from the job before touching tenant data.

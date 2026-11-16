# 07 — Technical Challenges and Architectural Decisions

## 1. Key decisions and their reasoning

| #   | Decision                                                                                                                                                                                                                                                                                                                                                   | Why                                                                                                                                                         | Trade-off accepted                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| D1  | **Python analytics as a separate service**, not scripts called from Node                                                                                                                                                                                                                                                                                   | Enforces the "analytics separated from business logic" requirement by process boundary; lets Python own pooling, retries and memory; testable in isolation. | Two runtimes to build and deploy; an internal API contract to maintain.                                               |
| D2  | **Postgres as job queue** (`FOR UPDATE SKIP LOCKED`)                                                                                                                                                                                                                                                                                                       | No Redis/RabbitMQ to operate; transactional enqueue (job is created in the same transaction as the data change).                                            | Lower throughput than a dedicated broker — irrelevant at SMB scale; revisit above ~50 jobs/s.                         |
| D3  | **Precomputed snapshots + on-demand queries with versioned cache**                                                                                                                                                                                                                                                                                         | Dashboards are fast and consistent; arbitrary filters still work; `data_version` makes invalidation exact.                                                  | Data can be up to ~15 minutes stale (shown in UI); storage for snapshots (pruned).                                    |
| D4  | **Shared schema multi-tenancy + RLS + app scoping**                                                                                                                                                                                                                                                                                                        | Cheap to run; RLS is a database-enforced backstop against the most damaging bug class in SaaS (tenant data leaks).                                          | Every query runs in a transaction with `set_config`; slight overhead and more careful connection handling.            |
| D5  | **Prisma owns all migrations**; Python uses raw SQL                                                                                                                                                                                                                                                                                                        | Single source of truth for schema.                                                                                                                          | Python lacks an ORM; mitigated by a small typed query layer and integration tests against the real schema.            |
| D6  | **Integer cents, UTC storage, org-time-zone periods**                                                                                                                                                                                                                                                                                                      | Exact money arithmetic; correct period boundaries for tenants outside UTC.                                                                                  | All period code must receive the time zone explicitly; DST tests required.                                            |
| D7  | **Inactivity-based churn by default**                                                                                                                                                                                                                                                                                                                      | Matches the main target verticals (retail, e-commerce, restaurants) where nobody "cancels".                                                                 | Subscription businesses get a less natural churn definition until [OPEN-1] is built.                                  |
| D8  | **Rule-based recommendations with measured "revenue at stake"**                                                                                                                                                                                                                                                                                            | Explainable, testable, no AI hallucination risk; complies with "don't present estimates as facts".                                                          | Less "smart"; rules need tuning per vertical (industry presets help).                                                 |
| D9  | **Versioned metric definitions and segment configs**                                                                                                                                                                                                                                                                                                       | Reproducibility and auditability: users can trust that a number from last month means the same thing.                                                       | More metadata to carry through API and UI.                                                                            |
| D10 | **Own auth (JWT + rotating refresh)** rather than an auth vendor                                                                                                                                                                                                                                                                                           | Full control and transparency for a portfolio-grade project.                                                                                                | Security responsibility is ours (mitigated by well-known patterns, tests, rate limits); revisit with SSO ([OPEN-12]). |
| D12 | **Product-scope decisions** (2026-11-15, see [01-srs.md](01-srs.md) §9.1): portfolio with production-grade foundations; inactivity churn only; net revenue excluding tax with refunds on the original order date; CSV + REST ingestion; editable industry presets; guest orders count toward revenue only; English i18n-ready UI; PaaS + managed Postgres. | These are the defaults the design was built around, so they need no structural changes.                                                                     | Subscription businesses get a less natural churn definition until P2; refunds can change past periods' revenue.       |
| D11 | **Monorepo with shared Zod contracts** generating OpenAPI and TS types                                                                                                                                                                                                                                                                                     | One schema validates requests, documents the API and types the frontend — no drift.                                                                         | Python side mirrors contracts with Pydantic manually (internal API is small).                                         |

## 2. Technical challenges and mitigations

### 2.1 Tenant isolation with Prisma and RLS

**Challenge:** Prisma has no built-in session variables; pooled connections can leak `app.org_id` between requests if set with session scope.
**Mitigation:** transaction-local `set_config(..., true)` inside an interactive transaction per request (via client extension); RLS policy treats an unset variable as "no rows"; isolation test suite runs against every endpoint; a lint rule forbids importing the raw Prisma client outside `infra/` and `auth`.

### 2.2 Correct period and time-zone handling

**Challenge:** an order at 23:30 on 31 March in Bogotá is 1 April in UTC. DST shifts make "a day" 23 or 25 hours in some zones.
**Mitigation:** compute business dates in SQL with `ordered_at AT TIME ZONE org_tz`; never bucket on UTC dates; shared fixture tests at month ends and DST transitions in both Python and TypeScript.

### 2.3 Statistical validity on small tenants

**Challenge:** a café with 200 customers produces noisy monthly rates; a 10-point retention "drop" may be random.
**Mitigation:** low-sample warnings, Wilson intervals, minimum sample sizes for recommendations, practical-significance thresholds, adaptive default grain.

### 2.4 RFM ties and skewed distributions

**Challenge:** most customers have one order, so frequency quintiles collapse; spend is heavily skewed.
**Mitigation:** average-rank ties (honest), fixed thresholds recommended for frequency, medians shown alongside means, documented in-app.

### 2.5 Right-censoring

**Challenge:** "average time to second purchase" over only repeat buyers is biased; recent cohorts look worse because they've had less time.
**Mitigation:** Kaplan–Meier estimates, cohort cells null until complete, CLV compared at fixed horizons (12 months).

### 2.6 Import data quality

**Challenge:** real CSVs have mixed date formats, decimal commas, currency symbols, duplicate IDs, missing customers for orders.
**Mitigation:** explicit mapping step with format options, validation preview before commit, row-level error file, idempotent upsert by external ID, data-quality report in analytics.

### 2.7 Analytics performance at scale

**Challenge:** loading 2M orders into Pandas per run is wasteful.
**Mitigation:** push per-customer and per-period aggregation into SQL (the Pandas input is ~100k customer rows, not 2M orders); only fetch order-level data where needed (gaps), with typed columns and `int32`/`category` dtypes; incremental recompute later if needed. Measured in M9 load tests.

### 2.8 Staleness and consistency between services

**Challenge:** users edit data and immediately look at the dashboard; snapshot may lag.
**Mitigation:** `data_version` in every response; UI shows "Updating…" when a recompute is pending; on-demand path always reflects the current `data_version`.

### 2.9 Definition changes over time

**Challenge:** fixing a formula changes historical numbers users may have reported.
**Mitigation:** definition versions in every snapshot and response; changelog on the methodology page; old snapshots are not silently rewritten.

### 2.10 Privacy of customer data

**Challenge:** tenants upload personal data of their customers; the platform acts as a data processor.
**Mitigation:** minimization (analytics reference IDs), masked fields for Viewers, audited exports, anonymization endpoint, no personal data in logs, retention policies ([OPEN-8]).

### 2.11 Exports and CSV injection

**Challenge:** fields starting with `=`, `+`, `-`, `@` execute as formulas in Excel.
**Mitigation:** prefix such values with `'` in exports; streamed generation to avoid memory spikes.

### 2.12 Keeping the scope analytical, not CRM

**Challenge:** customer management features tend to grow (notes, tasks, pipelines).
**Mitigation:** product rule in SRS §1.2; every customer-management feature must feed or explain an analysis.

## 3. Decisions deferred (with trigger to revisit)

| Topic                           | Current stance | Revisit when                                                                         |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| Data warehouse / columnar store | Not needed     | A tenant exceeds ~20M orders, or analytics runs exceed 5 minutes.                    |
| Redis (cache/queue)             | Not needed     | Queue throughput or rate-limit state across many API instances becomes a bottleneck. |
| Splitting services further      | No             | A module needs independent scaling or a separate team owns it.                       |
| Event streaming / real-time     | No             | Integrations push high-volume events (web tracking).                                 |
| Predictive models               | Deferred to P2 | Backtest framework is in place and enough tenants have ≥ 18 months of history.       |

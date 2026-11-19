# Hardening report (M9)

Results of the M9 checks, run on 2026-11-18/19 against the production images (`docker-compose.prod.yml`) on a development laptop (8 vCPU, Postgres, API, analytics and nginx sharing it). Re-run the commands below after significant changes.

## 1. Performance at A1 volume

**Dataset.** One tenant generated with `insights.datagen` (subscription profile, 36 months): **100,000 customers and 1,222,946 orders**. A1 allows up to 2M orders; at this size the work is linear in orders, and the slowest step measured below has 25% headroom.

### Full analytics recompute (NFR-PERF-03: under 2 minutes)

| Version                                                         | Load     | Compute | Write | Total          |
| --------------------------------------------------------------- | -------- | ------- | ----- | -------------- |
| Before M9, right after a bulk import (stale planner statistics) | > 10 min | —       | —     | did not finish |
| Hash joins forced for the load transaction                      | 8.0 s    | 150.5 s | 8.6 s | 158 s          |
| + purchase history built once per run instead of per month      | 7.4 s    | 83.2 s  | 8.6 s | **91 s** ✅    |

Two fixes:

- **Load.** Right after a bulk load, Postgres had not re-analysed the tables, picked nested loops, and the purchases query ran for over ten minutes. The load transaction now sets `enable_nestloop = off`: these queries always aggregate a whole organization, where hash joins win.
- **Compute.** The 24-month trend recomputed a sort and grouped shift over the full history for every month. That history (`PurchaseDays`) is now built once per data frame and memoised, along with the identified-customer frame and first-purchase dates.

### On-demand analytics (first request per data version; later ones come from the query cache)

| Query                                            | Before                       | After     |
| ------------------------------------------------ | ---------------------------- | --------- |
| Churn (series + by segment + list)               | 93.4 s (over the 30 s limit) | 16.3 s    |
| Overview (period + comparison)                   | 17.6 s                       | 8.4 s     |
| Retention                                        | 10.1 s                       | 5.1 s     |
| Cohorts / frequency / CLV / journey / engagement | 2.7–3.9 s                    | 1.6–3.6 s |

All cold queries now finish within the API's 30 s analytics timeout. Every later request for the same data version is served from `analytics_query_cache` in milliseconds.

### API load test (k6, [`infra/load/a1.k6.js`](../infra/load/a1.k6.js))

Through nginx, as on Render: 25 concurrent users (15 on customer and order pages, 10 on dashboards), each making one request at a time with 0.5–1.5 s of think time, for 60 s.

| Metric                      | Target   | Result                  |
| --------------------------- | -------- | ----------------------- |
| CRUD p95 (NFR-PERF-01)      | < 300 ms | **174 ms** ✅           |
| Dashboard p95 (NFR-PERF-02) | < 500 ms | **29 ms** ✅            |
| Failed requests             | < 1%     | **0%** (1,525 requests) |

Fixes made on the way:

- **Connection pool.** The first run failed 77% of requests: every request opens a transaction, and Prisma gave up waiting for a pool connection after 2 s. The pool is now configurable (`DATABASE_POOL_SIZE`, default 20), and a transaction waits up to 10 s for a connection.
- **Customer list.** It aggregated every order of the tenant on each page (2.6 s at 1.2M orders). It now picks the page first and computes live stats for those 50 customers only. Sorting and filtering by spend, order count or last purchase use the latest snapshot (refreshed within about 10 minutes of a change); the figures shown stay live.
- **Segments.** The per-snapshot aggregates are cached per run, since snapshots never change.

Stress, for reference: 20 users sending five parallel requests with no think time (about 60 requests/s on this laptop) reach CRUD p95 1.2 s and dashboard p95 0.8 s with no errors. The database CPU is the limit. A dedicated Postgres instance moves it.

Search (`ILIKE` over a trigram index) and the spend sort are the slowest customer queries (about 130 ms and 95 ms alone). If they become a problem, the spend sort can be served from an index on the snapshot table.

## 2. Security review

**Dependency audit.**

- `npm audit` found one high-severity runtime issue: nodemailer < 10.6, several advisories in address parsing and SMTP handling. Fixed by upgrading to nodemailer 10.6.
- Moderate advisories in dev-only tooling (`typescript-eslint` → `minimatch`) were fixed with `npm audit fix`.
- Remaining: one _low_ advisory in `esbuild`'s development server on Windows (build-time only, not shipped).
- `pip-audit` over the analytics service's locked runtime dependencies: no known vulnerabilities.

**Row-level security.** `test/integration/security.test.ts` fails the build if any table in `public`:

- lacks row-level security, either enabled or forced;
- has no policy, except the documented exceptions (`users`, `refresh_tokens`, `password_reset_tokens`, `jobs`, `_prisma_migrations`).

It also checks that the runtime role is not superuser, cannot bypass RLS and cannot create objects, and that tenant tables are empty without an organization context. The cross-tenant tests in `isolation.test.ts` plus the per-feature outsider tests (customers, interactions, recommendations, reports, exports, privacy) exercise isolation through the API.

**OWASP Top 10 checklist.**

| Risk                                  | Mitigation                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 Broken access control             | Role checks on every route; RLS as a second layer; outsider and viewer tests per feature; IDs validated as UUIDs (404 otherwise).                                                       |
| A02 Cryptographic failures            | Argon2id passwords; refresh, reset and invitation tokens stored as SHA-256 hashes; HTTPS with HSTS at the edge; secrets only in environment variables (generated by Render).            |
| A03 Injection                         | Parameterised queries everywhere (`Prisma.sql`); the few dynamic identifiers come from fixed whitelists; CSV cells are formula-neutralised.                                             |
| A04 Insecure design                   | Single-use, expiring links in URL fragments (never in logs or Referer); forgot-password always answers 202; dismissing a recommendation needs a reason.                                 |
| A05 Security misconfiguration         | Strict CSP and security headers from nginx and Helmet; analytics and API on the private network only; `/metrics` disabled without a token and blocked at the edge; non-root containers. |
| A06 Vulnerable components             | Audits above; Dependabot opens weekly update PRs for npm, uv, Docker base images and Actions (`.github/dependabot.yml`).                                                                |
| A07 Identification and authentication | Rate-limited login and recovery; refresh-token rotation with reuse detection; all sessions revoked on password reset; removing a member revokes their sessions.                         |
| A08 Software and data integrity       | Lockfiles (`package-lock.json`, `uv.lock`); images built from the repository by Render.                                                                                                 |
| A09 Logging and monitoring            | JSON logs with request IDs and no personal data; audit log for security-relevant actions and exports; job failure alerts (§4 of the deployment guide).                                  |
| A10 SSRF                              | The server makes no requests to user-supplied URLs (SMTP and analytics hosts come from configuration).                                                                                  |

**Secrets.** Nothing secret is in the repository. `render.yaml` uses `generateValue` or `sync: false` for every secret, and the local compose files carry development-only values.

## 3. Privacy

- **Right to erasure (CUS-10).** `POST /customers/:id/erase` with `anonymize` (PII cleared, orders kept for aggregates) or `delete` (record and interactions removed; orders become guest revenue). The audit entry names the customer ID only.
- **Data export (NFR-PRV-02).** `POST /organization/export` (owner) builds a ZIP with every table as CSV plus a README. The archive is built in memory, which suits organizations up to roughly a million rows; larger ones need a streamed archive.
- **Organization deletion.** `DELETE /organization` with the organization's exact name removes all of its data, including the analytics tables without foreign keys and its stored files. Member accounts remain for their other organizations.
- **Retention (OPEN-11).** See the deployment guide §4.
- **Processor role (NFR-PRV-03).** The platform processes customer data on behalf of each organization (the controller). Data stays within the organization (RLS); the platform uses it only to compute that organization's analytics; deletion and export are self-service for owners. The hosting region is the one chosen for the Render services.

## 4. Accessibility

- axe-core (WCAG 2.1 A/AA rules) runs inside the web test suite on:
  - sign-in, sign-up and forgot-password;
  - Overview, Behavior, Customer value, Recommendations (detail), Team, Reports, Settings, Customers and Imports.
- No violations are left. A guard test proves the check really detects missing alt text and labels.
- Colour contrast cannot be computed in jsdom, so it was checked on the design tokens. One failure was fixed: `ink-subtle`, used for small hint text and chart labels, was 2.8–4.1:1 in both themes. It is now `#696f7a` (light) and `#848c9a` (dark), at least 4.5:1 on every surface.
- Charts keep their data tables (NFR-UX-01).

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

Re-run after the code audit (§4), same laptop and data, API started with `RATE_LIMIT_PER_USER=100000`: CRUD p95 first measured **506 ms** with a warm database. The commit before the audit, built and run the same afternoon, measured 785 ms–1.04 s, so the audit changes cost nothing; the machine was slower than for the 174 ms run. Two customer-list problems explained the thin margin, and are fixed:

- **Default order.** The list sorts by `(created_at, id)` but the index had only `created_at`. Customers created together (one import, one generator run) share `created_at`, so Postgres read and sorted all 100,000 to return 50 (265 ms). The index is now `(organization_id, created_at, id)`: 0.1 ms.
- **Search.** Postgres never uses an index for a non-leakproof operator such as `ILIKE` under RLS, and cannot use column statistics to estimate it either, so the trigram index had never been used: every search concatenated and case-folded each customer's text (100 ms). Search now matches a stored, lowercased `search_text` column with `LIKE` (25 ms for a full scan; 10 ms for common terms, which stop at the first page) and the unused index is gone.

After the fixes, same conditions, two runs: CRUD p95 **132–136 ms**, dashboard p95 **29–32 ms**, 0% failed.

The spend, order-count and last-purchase sorts are now the slowest customer queries (about 90–125 ms alone at A1): they join every customer to the latest snapshot to sort. If they become a problem, they can be served from an index on the snapshot table, with customers created after the snapshot merged in separately.

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
- **Data export (NFR-PRV-02).** `POST /organization/export` (owner) builds a ZIP with every table as CSV plus a README. The tables are read in pages of 5,000 rows inside one snapshot (REPEATABLE READ) transaction and streamed into the archive on disk, so memory stays flat and the export is consistent. Limit: 4 GiB per archive (no ZIP64). Measured at A1 (100,000 customers, 1,222,946 orders; 225 MB of CSV, 58 MB zipped): 37 s, every row present and CRCs valid; with the API container capped at 512 MB like the Render starter plan, 63 s with a peak of 215 MB resident, and `GET /orders` kept answering meanwhile (median 71 ms).
- **Organization deletion.** `DELETE /organization` with the organization's exact name removes all of its data, including the analytics tables without foreign keys and its stored files. Member accounts remain for their other organizations.
- **Retention (OPEN-11).** See the deployment guide §4.
- **Processor role (NFR-PRV-03).** The platform processes customer data on behalf of each organization (the controller). Data stays within the organization (RLS); the platform uses it only to compute that organization's analytics; deletion and export are self-service for owners. The hosting region is the one chosen for the Render services.

## 4. Code audit (2026-11-19)

A review of the finished code after M9 found these, now fixed:

| Severity | Finding                                                                                                                                                                                                                                     | Fix                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| High     | The §4 limits of the API spec existed only for auth routes: any member could start unlimited exports, PDFs and recomputes.                                                                                                                  | Per-user (300/min) and per-organization export/recompute (10/min) limits, `429` with `Retry-After`.                        |
| High     | The organization export loaded every table into memory in one 30 s transaction and zipped synchronously in the API process (event loop blocked).                                                                                            | Paged reads in one snapshot transaction, streamed ZIP with async deflate.                                                  |
| Medium   | Customer search could never use its trigram index under RLS (`ILIKE` is not leakproof), and the default list order had no index for its `id` tie-breaker: at A1 both scanned every customer, and CRUD p95 rose to 506 ms on a busy machine. | `(organization_id, created_at, id)` index; stored lowercased `search_text` matched with `LIKE`; unused index dropped (§1). |
| Medium   | Role and membership came from the access token: a removed or demoted member kept their access for up to 15 minutes.                                                                                                                         | Membership and role re-read per request (10 s cache, cleared by team changes).                                             |
| Medium   | Request logs kept full URLs, so search terms (names, emails) reached the logs; the log-only mailer logged recipients.                                                                                                                       | Paths only in request logs; recipients no longer logged.                                                                   |
| Low      | Downloads used `.pipe()` with no error handling: a read error after the headers could crash the process. An error after headers were sent tried a second response.                                                                          | `pipeline()` for downloads; the error handler ends an interrupted response.                                                |
| Low      | Forgot-password waited for SMTP only for existing accounts (timing oracle).                                                                                                                                                                 | The email is sent after the response.                                                                                      |
| Low      | Docs drift (container versions, `req.ctx`, the rate-limit table); the customer CSV used LF rows unlike the other CSVs.                                                                                                                      | Corrected.                                                                                                                 |

Known and accepted, or left for later:

- Rate-limit counters and the membership cache are per process (one API instance on Render). A shared store is needed before scaling out.
- No email verification at signup: an address can be registered by someone who does not own it.
- The invitation preview says whether the invited email already has an account; anyone holding the link sees it.
- Cold analytics queries on a new date range take up to 16 s at A1 volume and are bounded only by the per-user limit and the 5-year range cap.
- Concurrent cache misses for the same analytics query compute it twice; a recompute running longer than the 15-minute stale-lock window could run twice.
- `Promise.all` over queries on one transaction client (seven modules) gains nothing, since one connection runs them in turn, and triggers a pg deprecation warning that becomes an error in pg 9.
- The analytics service caches up to 8 organizations' data frames in memory with no byte limit; size the instance for it, or lower the cache, with many large tenants.

## 5. Accessibility

- axe-core (WCAG 2.1 A/AA rules) runs inside the web test suite on:
  - sign-in, sign-up and forgot-password;
  - Overview, Behavior, Customer value, Recommendations (detail), Team, Reports, Settings, Customers and Imports.
- No violations are left. A guard test proves the check really detects missing alt text and labels.
- Colour contrast cannot be computed in jsdom, so it was checked on the design tokens. One failure was fixed: `ink-subtle`, used for small hint text and chart labels, was 2.8–4.1:1 in both themes. It is now `#696f7a` (light) and `#848c9a` (dark), at least 4.5:1 on every surface.
- Charts keep their data tables (NFR-UX-01).

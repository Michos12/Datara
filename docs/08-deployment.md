# Deployment (Render)

Production runs on [Render](https://render.com) from the Blueprint in [`render.yaml`](../render.yaml) (OPEN-13, decided in M9). Before the first deploy, run the same production images locally with [`docker-compose.prod.yml`](../docker-compose.prod.yml).

## 1. Topology

```mermaid
flowchart LR
  user([Browser]) -- HTTPS --> web["customer-insights-web<br/>(public web service)<br/>nginx: SPA + /api proxy"]
  web -- private network --> api["customer-insights-api<br/>(private service)<br/>Express + in-process job loop"]
  api --- disk[("disk /data/storage<br/>uploads, reports, exports")]
  api -- private network --> analytics["customer-insights-analytics<br/>(private service)<br/>FastAPI"]
  worker["customer-insights-analytics-worker<br/>(background worker)"]
  api --> db[("customer-insights-db<br/>managed Postgres 17")]
  analytics --> db
  worker --> db
```

- **One public origin.** Only the web service has a URL. Its nginx serves the built SPA and proxies `/api/` to the private API service, so the refresh cookie is first-party (`SameSite=Strict`) and no CORS is needed. The analytics service has no public URL (NFR-SEC-05).
- **The API runs the Node job loop in-process** (`WORKER_IN_PROCESS=true`). Imports, PDF reports and data exports read and write files on the API's disk, and a Render disk attaches to a single service. The cost: the API runs as one instance and deploys are not zero-downtime. When that matters, move storage to object storage and run `node dist/worker.js` as a separate background worker.
- **Two database roles.** The Blueprint's database user (`insights_owner`) owns the schema and runs migrations. The app and the analytics service connect as `app_user`, created by `npm run db:deploy`, which cannot bypass row-level security. The services derive `app_user`'s URL from the owner URL plus `APP_DB_USER`/`APP_DB_PASSWORD`, so `render.yaml` stays declarative.

## 2. First deploy

1. Push the repository to GitHub (CI must be green).
2. Render Dashboard → **New → Blueprint** → select the repository. Render reads `render.yaml` and proposes the database, an environment group and four services. Secrets marked `generateValue` (JWT secret, service token, app role password, metrics token) are generated for you.
3. Render asks for the `sync: false` values. Leave them empty for now, or fill in what you know:
   - `APP_URL`: the web service URL, e.g. `https://customer-insights-web.onrender.com`, used in email links.
   - `SMTP_URL`: `smtps://USER:PASSWORD@smtp.example.com:465` from your email provider (Postmark, Resend, SES, Mailgun…). Without it, invitation and reset emails are dropped and logged. The app keeps working.
   - `MAIL_FROM`: e.g. `Customer Insights <no-reply@yourdomain>`; the domain must be verified with the provider.
4. Apply. The API's pre-deploy step creates `app_user`, migrates, and re-grants. Each release repeats this step, which is idempotent.
5. When all services are live, set `APP_URL` on the API service to the web URL if you skipped it, and redeploy the API.
6. Open the web URL, sign up (this creates your organization and you as its owner), and load demo data from Customers to check the analytics worker end to end.

Checklist after the first deploy:

| Check                                 | How                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| HTTPS and security headers            | `curl -sI https://<web>/` shows `strict-transport-security`, `content-security-policy`.                             |
| API, database and analytics reachable | `https://<web>/api/v1/ready` → `{"status":"ready", "checks": {"database":"up","migrations":"up","analytics":"up"}}` |
| Analytics service private             | It has no URL in the dashboard; only `customer-insights-api` reaches it.                                            |
| Metrics not public                    | `https://<web>/api/v1/metrics` → 404.                                                                               |
| Emails                                | Invite a teammate (Team page); the email arrives and the link opens `/invitation`.                                  |
| Jobs                                  | Load demo data; the overview fills within a minute; a PDF report downloads from Reports.                            |

## 3. Configuration reference

| Variable                           | Service                | Purpose                                                                                                      |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `DIRECT_DATABASE_URL`              | api, analytics, worker | Owner connection (from the database). Migrations use it; the runtime URL is derived from it.                 |
| `APP_DB_USER`, `APP_DB_PASSWORD`   | all                    | Runtime role (subject to RLS).                                                                               |
| `DATABASE_URL`                     | all                    | Optional: an explicit runtime URL overrides the derivation.                                                  |
| `ANALYTICS_URL`                    | api                    | `host:port` of the analytics service (from Render's private network).                                        |
| `ANALYTICS_SERVICE_TOKEN`          | api, analytics         | Shared secret on internal calls.                                                                             |
| `JWT_SECRET`                       | api                    | HMAC key for access tokens (≥ 32 characters).                                                                |
| `DATABASE_POOL_SIZE`               | api                    | Connections per API process (default 20). Keep the sum under the database's connection limit.                |
| `WORKER_IN_PROCESS`                | api                    | Run the job loop in the API process.                                                                         |
| `STORAGE_DIR`                      | api                    | Uploads and generated files (`/data/storage`, the disk).                                                     |
| `TRUST_PROXY`                      | api                    | Proxy hops in front of the API (`2`: Render's edge and nginx), for client IPs in rate limits and audit logs. |
| `APP_URL`, `SMTP_URL`, `MAIL_FROM` | api                    | Email links and delivery.                                                                                    |
| `METRICS_TOKEN`                    | api                    | Enables `GET /api/v1/metrics` with `Authorization: Bearer <token>` (private network only).                   |
| `RATE_LIMIT_PER_USER`              | api                    | Authenticated requests per user per minute (default 300).                                                    |
| `RATE_LIMIT_EXPENSIVE_PER_ORG`     | api                    | Exports, PDF reports, recomputes and demo data per organization per minute (default 10).                     |
| `API_UPSTREAM`                     | web                    | `host:port` of the API (from Render's private network).                                                      |

## 4. Operations

**Logs.** Every service writes JSON lines (request ID; organization ID where relevant; never personal data). Render keeps them in the dashboard; add a log stream (Datadog, Better Stack, Papertrail…) under _Account settings → Log streams_ to keep them longer and search them.

**Metrics and alerts.** From any private service, scrape `http://customer-insights-api:10000/api/v1/metrics` with the bearer token. It reports request latency by route template, job outcomes and durations, and three alerting gauges:

| Gauge                     | Alert when                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `jobs_failed_24h`         | > 0: a job failed after all retries. Analytics recomputes, imports, reports and exports all count. |
| `jobs_oldest_due_seconds` | > 900: the queue is stuck (a worker is down).                                                      |
| `jobs_due`                | grows steadily: workers cannot keep up.                                                            |

Permanently failed jobs are also logged at error level with `"alert": true`, so a log-based alert works without a metrics scraper. Render's own service health alerts (deploy failed, service down) go to the account's email.

**Backups.** Render's paid Postgres plans include automated backups with point-in-time recovery. The retention window depends on the plan: check the database's _Recovery_ tab and pick a plan that covers NFR-REL-03 (daily backups). Free databases have no backups and expire, so production needs a paid plan.

**Verify a backup (restore test).** Do this once after go-live and then quarterly:

1. Dashboard → `customer-insights-db` → _Recovery_ → restore to a **new** database at a recent point in time.
2. Compare row counts between the live and restored databases:

   ```bash
   for url in "$LIVE_DATABASE_URL" "$RESTORED_DATABASE_URL"; do
     psql "$url" -At -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname" > "counts-$(echo "$url" | md5sum | cut -c1-6).txt"
   done
   diff counts-*.txt && echo "restore OK"
   ```

3. Delete the restored database.

The same procedure runs locally against the production images with `sh infra/backup/restore-check.sh` (exact `count(*)` per table). It was last run on 2026-11-19: 22 tables, 1,586,653 rows restored identically from a 65 MB dump in 40 s.

**Rollback.** Render keeps previous deploys: _Service → Events → Rollback_. Migrations are forward-only. A release whose migration must be undone needs a new migration, so keep each migration backwards-compatible with the previous release.

**Retention** runs by itself. The nightly analytics recompute prunes each organization's snapshots (the latest 7, plus one per month for 24 months), audit log (12 months), finished invitations and the query cache. A daily `maintenance.cleanup` job removes finished jobs (30 days), expired tokens (7 days), uploaded CSVs (30 days) and generated reports and exports (7 days). See [05-analytics-methodology.md §12](05-analytics-methodology.md#12-data-retention).

## 5. Local production smoke test

```bash
docker compose -f docker-compose.prod.yml up --build
```

Then open http://localhost:8080. Emails go to Mailpit at http://localhost:8026. The database starts empty with only the owner role, like Render's, and the API's start command runs the same `npm run db:deploy` as Render's pre-deploy step. Stop and delete everything with `docker compose -f docker-compose.prod.yml down -v`.

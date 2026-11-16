# 04 — REST API Specification

Base URL: `/api/v1`. JSON request and response bodies (`Content-Type: application/json`) except file uploads and CSV downloads. The machine-readable OpenAPI 3.1 document is generated from the Zod schemas and served at `/api/v1/openapi.json` (docs UI at `/api/docs` in non-production environments).

## 1. Conventions

### 1.1 Authentication

- `Authorization: Bearer <access_token>` on every endpoint except those marked **public**.
- The access token (JWT, 15 min) contains `sub` (user ID), `org` (active organization ID), `role`, `jti`.
- The refresh token is an opaque random value in an `httpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth`. The refresh endpoint also requires an `X-CSRF-Token` header matching a non-httpOnly CSRF cookie (double-submit).

### 1.2 Roles

`O` Owner, `A` Admin, `N` Analyst, `V` Viewer. Each endpoint lists the minimum roles allowed.

### 1.3 Tenancy

The organization always comes from the token, **never** from the URL or body. Resources in another organization return `404`.

### 1.4 Pagination, sorting, filtering

- Cursor pagination for large lists: `?limit=50&cursor=<opaque>` → `{ "data": [...], "page": { "nextCursor": "…" | null, "limit": 50 } }`. `limit` max 200.
- Sorting: `?sort=-total_spent,last_name` (`-` = descending; allowed fields listed per endpoint).
- Dates: ISO 8601. Date-only parameters (`start`, `end`, `as_of`) are interpreted in the **organization time zone**. `start` is inclusive, `end` is exclusive.

### 1.5 Errors (RFC 9457 problem details)

```json
{
  "type": "https://docs.customer-insights.app/errors/validation",
  "title": "Validation failed",
  "status": 422,
  "code": "VALIDATION_FAILED",
  "detail": "2 fields are invalid",
  "requestId": "01J…",
  "errors": [
    { "path": "email", "message": "Must be a valid email" },
    { "path": "orderedAt", "message": "Cannot be in the future" }
  ]
}
```

| Status | `code` examples                     | When                                                              |
| ------ | ----------------------------------- | ----------------------------------------------------------------- |
| 400    | `BAD_REQUEST`                       | Malformed JSON, bad query syntax                                  |
| 401    | `UNAUTHENTICATED`, `TOKEN_EXPIRED`  | Missing/invalid token                                             |
| 403    | `FORBIDDEN`                         | Role not allowed                                                  |
| 404    | `NOT_FOUND`                         | Missing or other tenant's resource                                |
| 409    | `CONFLICT`, `DUPLICATE_EXTERNAL_ID` | Uniqueness or state conflict                                      |
| 422    | `VALIDATION_FAILED`                 | Schema validation                                                 |
| 429    | `RATE_LIMITED`                      | Too many requests (`Retry-After` header)                          |
| 503    | `ANALYTICS_UNAVAILABLE`             | Analytics service down; snapshot data still served where possible |

### 1.6 Analytics response envelope

Every analytics endpoint returns metric metadata alongside values (ANA-09):

```json
{
  "meta": {
    "metric": "retention_rate",
    "definitionVersion": 1,
    "kind": "measured",
    "period": { "start": "2026-01-01", "end": "2026-11-01", "grain": "month" },
    "asOf": "2026-10-31",
    "timezone": "America/Bogota",
    "currency": "USD",
    "computedAt": "2026-11-01T07:02:11Z",
    "runId": "…",
    "filters": { "segment": null },
    "warnings": [{ "code": "LOW_SAMPLE", "message": "3 periods have fewer than 30 customers" }]
  },
  "data": {}
}
```

### 1.7 Common analytics query parameters

| Param     | Type                                       | Default                        | Notes                                                        |
| --------- | ------------------------------------------ | ------------------------------ | ------------------------------------------------------------ |
| `start`   | date                                       | 12 months before `end`         | inclusive                                                    |
| `end`     | date                                       | first day of the current month | exclusive                                                    |
| `grain`   | `day`\|`week`\|`month`\|`quarter`          | `month`                        | where applicable                                             |
| `segment` | string (segment key)                       | none                           | filter to customers whose segment **at `as_of`** is this key |
| `compare` | `previous_period`\|`previous_year`\|`none` | `previous_period`              | for KPI deltas                                               |
| `asOf`    | date                                       | `end − 1 day`                  | reference date for recency-based metrics                     |

Money is returned as integer `…Cents` fields plus the `currency` in `meta`.

---

## 2. Endpoints

### 2.1 Health (public)

| Method | Path      | Description                                                                                     |
| ------ | --------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/health` | Liveness.                                                                                       |
| GET    | `/ready`  | Readiness: DB reachable, migrations applied, analytics service status (reported, not required). |

### 2.2 Auth

| Method | Path                        | Roles  | Description                                                                                                                                         |
| ------ | --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/signup`              | public | `{ email, password, fullName, organization: { name, timezone, currency, industry } }` → `201 { user, organization, accessToken }` + refresh cookie. |
| POST   | `/auth/login`               | public | `{ email, password }` → `200 { user, memberships, accessToken }`. Rate-limited.                                                                     |
| POST   | `/auth/refresh`             | cookie | Rotates the refresh token → `{ accessToken }`. Reuse of a rotated token revokes the family → `401`.                                                 |
| POST   | `/auth/logout`              | any    | Revokes the current refresh token. `204`.                                                                                                           |
| POST   | `/auth/switch-organization` | any    | `{ organizationId }` → new access token for that membership. (P1)                                                                                   |
| POST   | `/auth/password/forgot`     | public | `{ email }` → always `202`. (P1)                                                                                                                    |
| POST   | `/auth/password/reset`      | public | `{ token, newPassword }` → `204`. (P1)                                                                                                              |
| GET    | `/auth/me`                  | any    | Current user, active organization, role.                                                                                                            |

### 2.3 Organization & members

| Method | Path                            | Roles  | Description                                                                                                                                     |
| ------ | ------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/organization`                 | OANV   | Settings of the active organization.                                                                                                            |
| PATCH  | `/organization`                 | OA     | Update name, timezone, `settings.activeWindowDays`, `settings.churnDays`, `settings.weekStart`. Timezone/threshold changes trigger a recompute. |
| GET    | `/organization/members`         | OA     | List members.                                                                                                                                   |
| PATCH  | `/organization/members/:userId` | OA     | Change role (Admins cannot change Owners).                                                                                                      |
| DELETE | `/organization/members/:userId` | OA     | Remove member.                                                                                                                                  |
| POST   | `/organization/invitations`     | OA     | `{ email, role }` (P1).                                                                                                                         |
| GET    | `/organization/invitations`     | OA     | Pending invitations (P1).                                                                                                                       |
| DELETE | `/organization/invitations/:id` | OA     | Revoke (P1).                                                                                                                                    |
| POST   | `/invitations/accept`           | public | `{ token, password?, fullName? }` (P1).                                                                                                         |
| POST   | `/organization/demo-data`       | O      | Generate a synthetic dataset (only when the organization has no data). → `202 { jobId }`.                                                       |
| GET    | `/organization/audit-logs`      | OA     | Paginated audit log.                                                                                                                            |

### 2.4 Customers

| Method | Path                             | Roles | Description                                                                                                                                                                                                                                                                                                            |
| ------ | -------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/customers`                     | OANV  | List. Query: `q` (search), `segment`, `lifecycle` (`active`\|`at_risk`\|`churned`\|`prospect`), `minSpent`, `maxSpent`, `lastOrderFrom`, `lastOrderTo`, `tag`, `sort` ∈ {`last_name`, `created_at`, `total_spent`, `order_count`, `last_order_date`}. Rows include latest-run metrics. Viewers get masked email/phone. |
| POST   | `/customers`                     | OAN   | Create. Body: `CustomerCreate`. `409 DUPLICATE_EXTERNAL_ID`. Response header `X-Warning: duplicate-email` when applicable.                                                                                                                                                                                             |
| GET    | `/customers/:id`                 | OANV  | Customer profile (§3.1).                                                                                                                                                                                                                                                                                               |
| PATCH  | `/customers/:id`                 | OAN   | Partial update.                                                                                                                                                                                                                                                                                                        |
| DELETE | `/customers/:id`                 | OA    | Soft delete. `204`.                                                                                                                                                                                                                                                                                                    |
| POST   | `/customers/:id/restore`         | OA    | Undo soft delete.                                                                                                                                                                                                                                                                                                      |
| POST   | `/customers/:id/anonymize`       | O A   | Irreversible erasure of personal fields; keeps order amounts for aggregates (P1).                                                                                                                                                                                                                                      |
| GET    | `/customers/:id/orders`          | OANV  | Paginated purchase history.                                                                                                                                                                                                                                                                                            |
| GET    | `/customers/:id/interactions`    | OANV  | Paginated interaction timeline (P1).                                                                                                                                                                                                                                                                                   |
| GET    | `/customers/:id/metrics-history` | OANV  | R/F/M scores and segment over past runs (P2).                                                                                                                                                                                                                                                                          |

### 2.5 Orders

| Method | Path          | Roles | Description                                                                                                 |
| ------ | ------------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| GET    | `/orders`     | OANV  | Query: `customerId`, `from`, `to`, `status`, `channel`, `minNet`, `maxNet`, `sort` ∈ {`ordered_at`, `net`}. |
| POST   | `/orders`     | OAN   | Create with optional `items[]`. Validates `refunded ≤ gross − discount`, `orderedAt ≤ now + 1 day`.         |
| GET    | `/orders/:id` | OANV  | Order with items.                                                                                           |
| PATCH  | `/orders/:id` | OAN   | Update (status, amounts, refund).                                                                           |
| DELETE | `/orders/:id` | OA    | Soft delete.                                                                                                |

All writes to customers/orders/interactions bump `organizations.data_version` and schedule a debounced recompute.

### 2.6 Interactions (P1)

| Method | Path                  | Roles | Description                                |
| ------ | --------------------- | ----- | ------------------------------------------ |
| GET    | `/interactions`       | OANV  | Query: `customerId`, `type`, `from`, `to`. |
| POST   | `/interactions`       | OAN   | Create one.                                |
| POST   | `/interactions/batch` | OAN   | Up to 1,000 per request.                   |
| DELETE | `/interactions/:id`   | OA    | Hard delete.                               |

### 2.7 Imports

| Method | Path                             | Roles | Description                                                                                                                                                |
| ------ | -------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/imports`                       | OA    | Raw CSV as the request body (`Content-Type: text/csv`, ≤ 50 MB), `?entity=customers\|orders&filename=…`. → `201 { import, sampleRows, suggestedMapping }`. |
| PUT    | `/imports/:id/mapping`           | OA    | `{ mapping: { "<csv column>": "<field>" }, options: { dateFormat, decimalSeparator, amountsAreCents } }` → starts validation job → `202`.                  |
| GET    | `/imports/:id`                   | OA    | Status, counts, first 100 errors.                                                                                                                          |
| GET    | `/imports/:id/errors.csv`        | OA    | Full row-level error report.                                                                                                                               |
| POST   | `/imports/:id/commit`            | OA    | Run the import (upsert by `external_id`). → `202 { jobId }`.                                                                                               |
| GET    | `/imports`                       | OA    | History.                                                                                                                                                   |
| GET    | `/imports/templates/:entity.csv` | OANV  | Downloadable CSV template.                                                                                                                                 |

### 2.8 Segments

| Method | Path                                          | Roles | Description                                                                                                                    |
| ------ | --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/segments`                                   | OANV  | Segment summary for the latest run: key, name, color, description, customer count, % customers, % revenue, avg R/F/M, avg CLV. |
| GET    | `/segments/matrix`                            | OANV  | Folded into `GET /segments` as `matrix[r-1][f-1]`.                                                                             |
| GET    | `/segments/migration?from=<runId>&to=<runId>` | OANV  | Flow matrix between two runs (P2).                                                                                             |
| GET    | `/segments/config`                            | OANV  | Active configuration.                                                                                                          |
| GET    | `/segments/config/versions`                   | OA    | History.                                                                                                                       |
| POST   | `/segments/config`                            | OA    | Create a new version (validated: rules must cover every (R,F) cell or a fallback must exist). Optionally `activate: true`.     |
| POST   | `/segments/config/preview`                    | OA    | Dry-run a configuration: returns resulting segment counts without saving.                                                      |
| POST   | `/segments/config/:version/activate`          | OA    | Activate a version → recompute.                                                                                                |

### 2.9 Analytics

All accept the common parameters in §1.7 where meaningful, and return the envelope in §1.6.

| Method | Path                             | Roles | Returns                                                                                                                                                                                      |
| ------ | -------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/analytics/overview`            | OANV  | KPI set with comparison deltas (§3.2).                                                                                                                                                       |
| GET    | `/analytics/overview` (sections) | OANV  | The overview response includes `trend[]` per bucket: `revenueNet`, `orders`, `aov`, `buyers`, `newCustomers`, `returningCustomers`, `partial`. Separate trend endpoints were folded into it. |
| GET    | `/analytics/retention`           | OANV  | Series: `retentionRate`, `retained`, `base` per period.                                                                                                                                      |
| GET    | `/analytics/churn`               | OANV  | Series: `churnRate`, `churned`, `base`; breakdown by segment at period start.                                                                                                                |
| GET    | `/analytics/churn/customers`     | OAN   | Customers who churned in the period (paginated).                                                                                                                                             |
| GET    | `/analytics/cohorts`             | OANV  | `metric` ∈ {`retention`, `revenue_per_customer`, `cumulative_revenue`}; `maxPeriods` (default 12). Matrix (§3.3).                                                                            |
| GET    | `/analytics/frequency`           | OANV  | Order-count histogram, repeat purchase rate, inter-purchase time stats, time-to-second-purchase distribution.                                                                                |
| GET    | `/analytics/clv`                 | OANV  | Historical CLV: average, median, distribution, by cohort, by segment. With `includeEstimate=true`: predicted CLV section with `kind: "estimated"` and assumptions (P2).                      |
| GET    | `/analytics/journey`             | OANV  | Lifecycle funnel and stage durations (P2).                                                                                                                                                   |
| GET    | `/analytics/engagement`          | OANV  | Interaction volume by type/channel, engaged-customer rate, score distribution (P2).                                                                                                          |
| GET    | `/analytics/status`              | OANV  | Latest run, whether the snapshot is stale, any pending recompute, and the last run's data-quality report.                                                                                    |
| POST   | `/analytics/runs`                | OAN   | Recompute now: moves the pending recompute forward or queues one → `202` with the status.                                                                                                    |
| GET    | `/analytics/definitions`         | OANV  | Metric registry: key, name, version, formula, period rules, kind (feeds the methodology page).                                                                                               |

### 2.10 Recommendations (P1)

| Method | Path                                 | Roles | Description                                                                                           |
| ------ | ------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------- |
| GET    | `/recommendations`                   | OANV  | Query: `status` (default `open,acknowledged`), `priority`, `ruleKey`. Sorted by `priorityScore` desc. |
| GET    | `/recommendations/:id`               | OANV  | Full detail (§3.4).                                                                                   |
| PATCH  | `/recommendations/:id`               | OAN   | `{ status: "acknowledged" \| "done" \| "dismissed", dismissReason? }`.                                |
| GET    | `/recommendations/:id/customers`     | OAN   | Affected customers (paginated).                                                                       |
| GET    | `/recommendations/:id/customers.csv` | OAN   | Export affected customers (audited).                                                                  |
| GET    | `/recommendations/rules`             | OA    | Rule catalogue with thresholds and enabled flag (P2: `PATCH` to tune).                                |

### 2.11 Reports & exports

| Method | Path                             | Roles | Description                                                                                                |
| ------ | -------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/exports/customers.csv`         | OAN   | Streamed export; accepts the `/customers` filters. Audited.                                                |
| GET    | `/exports/orders.csv`            | OAN   | Streamed; accepts `/orders` filters. Audited.                                                              |
| GET    | `/exports/kpis.csv`              | OANV  | KPI values for a period (+ comparison).                                                                    |
| GET    | `/exports/analytics/:metric.csv` | OANV  | Data behind any analytics chart (same params as the JSON endpoint).                                        |
| GET    | `/reports/comparison`            | OANV  | `periodA[start,end]`, `periodB[start,end]`, `segment?` → KPI list with A, B, absolute and relative change. |
| POST   | `/reports/pdf`                   | OAN   | `{ start, end, segment?, sections[] }` → `202 { jobId }` (P2).                                             |
| GET    | `/reports/pdf/:jobId`            | OAN   | Status or file download (P2).                                                                              |

### 2.12 Jobs

| Method | Path        | Roles | Description                                                    |
| ------ | ----------- | ----- | -------------------------------------------------------------- |
| GET    | `/jobs/:id` | OAN   | Status, progress, error. Only jobs of the active organization. |

### 2.13 Internal analytics service (not public)

Reachable only on the private network; authenticated with a shared service token (`X-Service-Token`) and receives `organizationId` explicitly.

| Method | Path                         | Description                                            |
| ------ | ---------------------------- | ------------------------------------------------------ |
| GET    | `/internal/health`           | Liveness.                                              |
| POST   | `/internal/query/{metric}`   | `{ organizationId, params }` → computed result + meta. |
| POST   | `/internal/segments/preview` | Dry-run a segment config.                              |
| GET    | `/internal/definitions`      | Metric registry.                                       |

---

## 3. Key payloads

### 3.1 `GET /customers/:id`

```json
{
  "id": "0193…",
  "externalId": "C-1042",
  "firstName": "Ana",
  "lastName": "Pérez",
  "email": "ana@example.com",
  "phone": "+57…",
  "country": "CO",
  "city": "Medellín",
  "registeredAt": "2024-03-02",
  "tags": ["newsletter"],
  "attributes": {},
  "metrics": {
    "asOf": "2026-11-14",
    "orderCount": 7,
    "totalNetCents": 48200,
    "aovCents": 6886,
    "firstOrderDate": "2024-03-05",
    "lastOrderDate": "2026-09-30",
    "recencyDays": 45,
    "frequencyPerMonth": 0.22,
    "medianGapDays": 96,
    "historicalClvCents": 48200,
    "lifecycleStatus": "active",
    "rfm": { "r": 3, "f": 4, "m": 4, "segment": { "key": "loyal", "name": "Loyal Customers" } }
  },
  "recentOrders": [
    { "id": "…", "orderedAt": "2026-09-30T15:12:00Z", "netCents": 7200, "status": "completed" }
  ],
  "recentInteractions": []
}
```

### 3.2 `GET /analytics/overview`

```json
{
  "meta": {
    "metric": "overview",
    "period": { "start": "2026-10-01", "end": "2026-11-01" },
    "comparePeriod": { "start": "2026-09-01", "end": "2026-10-01" },
    "…": "…"
  },
  "data": {
    "kpis": [
      {
        "key": "total_customers",
        "value": 4120,
        "previous": 3985,
        "change": 0.0339,
        "kind": "measured"
      },
      {
        "key": "active_customers",
        "value": 1830,
        "previous": 1790,
        "change": 0.0223,
        "kind": "measured"
      },
      { "key": "new_customers", "value": 135, "previous": 150, "change": -0.1, "kind": "measured" },
      {
        "key": "returning_customers",
        "value": 610,
        "previous": 590,
        "change": 0.0339,
        "kind": "measured"
      },
      {
        "key": "retention_rate",
        "value": 0.412,
        "previous": 0.43,
        "change": -0.018,
        "changeType": "points",
        "kind": "measured"
      },
      {
        "key": "churn_rate",
        "value": 0.041,
        "previous": 0.038,
        "change": 0.003,
        "changeType": "points",
        "kind": "measured"
      },
      { "key": "aov_cents", "value": 5240, "previous": 5110, "change": 0.0254, "kind": "measured" },
      {
        "key": "historical_clv_cents",
        "value": 18350,
        "previous": 18010,
        "change": 0.0189,
        "kind": "measured"
      }
    ]
  }
}
```

Rates report `changeType: "points"` (percentage-point difference), counts and money report relative change.

### 3.3 `GET /analytics/cohorts?metric=retention`

```json
{
  "meta": { "metric": "cohort_retention", "definitionVersion": 1, "kind": "measured", "…": "…" },
  "data": {
    "periods": [0, 1, 2, 3],
    "cohorts": [
      { "cohort": "2026-06", "size": 210, "values": [1.0, 0.31, 0.24, 0.22] },
      { "cohort": "2026-07", "size": 188, "values": [1.0, 0.28, 0.21, null] }
    ]
  }
}
```

`null` = period not yet complete (never shown as 0).

### 3.4 Recommendation

```json
{
  "id": "…",
  "ruleKey": "churn_risk_high_value",
  "ruleVersion": 1,
  "priority": "high",
  "status": "open",
  "title": "142 high-value customers are at risk of churning",
  "opportunity": "Protect revenue from customers who used to buy often but have gone quiet.",
  "explanation": "These customers have F and M scores of 4–5 but have not purchased for 1.5× their usual interval (median 38 days, now 61+ days).",
  "suggestedAction": "Send a personalised win-back offer within 14 days; prioritise the top 30 by historical spend.",
  "metrics": {
    "affectedCustomers": 142,
    "historicalRevenueCents": 9120000,
    "medianDaysSinceLastOrder": 64,
    "medianUsualGapDays": 38,
    "shareOfLast12mRevenue": 0.18
  },
  "revenueAtStakeCents": 1640000,
  "revenueAtStakeBasis": "affected customers' net revenue in the 12 months before asOf (measured)",
  "firstDetectedAt": "2026-11-02T07:01:00Z",
  "lastDetectedAt": "2026-11-15T07:01:00Z"
}
```

## 4. Rate limits (initial)

| Scope                                  | Limit                                 |
| -------------------------------------- | ------------------------------------- |
| `POST /auth/login`, `/auth/password/*` | 5 / min per IP+email; 20 / min per IP |
| Authenticated API                      | 300 / min per user                    |
| Exports & recompute triggers           | 10 / min per organization             |

## 5. Versioning and compatibility

- Path versioning (`/api/v1`). Additive changes (new fields, endpoints) do not bump the version. Removing/renaming fields does.
- Analytics `definitionVersion` is independent of API version: a corrected formula is a new definition version, visible in `meta`.

# 01 — Software Requirements Specification (SRS)

**Product:** Customer Insights
**Version:** 0.1 (pre-implementation draft)
**Date:** 2026-11-15
**Status:** Draft. Items marked **[OPEN-n]** need a decision before the milestone that depends on them (see §9).

---

## 1. Introduction

### 1.1 Purpose

This document specifies the functional and non-functional requirements of Customer Insights, a multi-tenant SaaS application that turns raw customer and transaction data into documented, reproducible customer analytics for small and medium-sized businesses (SMBs).

### 1.2 Product positioning

Customer Insights is an **analytics product with a customer data layer**, not a CRM. The deciding test for any feature is: _does it help a business understand or act on customer behavior?_ Customer CRUD exists to feed and explain the analytics. Sales pipelines, deal tracking, ticketing and email sending are out of scope.

### 1.3 Definitions

| Term                     | Meaning                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Organization (tenant)    | A business account. All business data belongs to exactly one organization.                                                   |
| Member                   | A user who belongs to an organization, with a role.                                                                          |
| Customer                 | A person or account that buys from the organization.                                                                         |
| Order                    | A completed purchase transaction with a monetary value.                                                                      |
| Interaction              | A non-purchase event linked to a customer (visit, email open, support contact, etc.).                                        |
| Reference date (`as_of`) | The date an analysis is computed "as of". Every metric has one.                                                              |
| Analysis period          | The `[start, end)` date range a metric covers, in the organization's time zone.                                              |
| Snapshot                 | A stored result of an analytics computation for a given `as_of`.                                                             |
| Measured metric          | A value computed directly from recorded data (for example, revenue last month).                                              |
| Estimated metric         | A value that relies on assumptions or a model (for example, predicted CLV). Always labeled as an estimate in the UI and API. |

Exact metric formulas live in [05-analytics-methodology.md](05-analytics-methodology.md).

### 1.4 References

- [02-architecture.md](02-architecture.md): system architecture and technical decisions
- [03-data-model.md](03-data-model.md): ERD and database schema
- [04-api-spec.md](04-api-spec.md): REST API
- [05-analytics-methodology.md](05-analytics-methodology.md): metric definitions
- [06-roadmap.md](06-roadmap.md): milestones

---

## 2. Overall description

### 2.1 User classes

| Role                          | Description                                                       | Typical permissions                                                                              |
| ----------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Owner**                     | Created the organization; responsible for billing and membership. | Everything, including deleting the organization and transferring ownership.                      |
| **Admin**                     | Manages data and configuration.                                   | Manage members (except owner), import data, edit customers/orders, configure segments and rules. |
| **Analyst**                   | Works with data and insights.                                     | Read all data, run analyses, export, manage recommendation status. Can edit customers/orders.    |
| **Viewer**                    | Consumes dashboards.                                              | Read-only dashboards and reports; no raw-data export of personal data.                           |
| **Platform admin** (internal) | Operates the SaaS.                                                | Not part of tenant data paths. Out of scope for MVP beyond a seed script.                        |

### 2.2 Operating environment

- Modern evergreen browsers (latest two versions of Chrome, Edge, Firefox, Safari). Desktop first; dashboards must stay usable on a tablet. Phone support is read-only "best effort".
- Server side runs in Docker containers. Local development uses Docker Compose.

### 2.3 Design constraints (from the specification)

- Frontend: React, TypeScript, Tailwind CSS, Apache ECharts.
- Backend: Node.js, Express, TypeScript, Prisma ORM, RESTful API.
- Database: PostgreSQL.
- Analytics: Python, Pandas, NumPy, SQL.
- Modular monolith first; frontend, API, database and analytics are separate layers.
- Recommendations start rule-based. No generative AI in the initial versions.

### 2.4 Assumptions

- **A1.** Typical tenant volume: up to 100k customers and 2M orders. The design must not fall over at 10x that, but does not have to be optimized for it at launch.
- **A2.** One currency per organization (set at creation). Multi-currency is out of scope.
- **A3.** Data arrives through manual entry, CSV import and (later) the API. Live integrations (Shopify, Stripe, POS) are post-MVP.
- **A4.** Analytics may be up to 15 minutes stale after a data change. Users can see when each snapshot was computed and can trigger a recompute.
- **A5.** The default business model is **non-contractual** (retail, e-commerce, restaurants): a customer can buy at any time and never formally cancels. Subscription (contractual) churn is a separate, later feature ([OPEN-1]).

---

## 3. Functional requirements

Priorities: **M** = MVP, **P1** = first post-MVP release, **P2** = later.

### 3.1 Accounts, organizations and access (AUTH)

| ID      | Requirement                                                                                                        | Pri |
| ------- | ------------------------------------------------------------------------------------------------------------------ | --- |
| AUTH-01 | A visitor can sign up with email and password, which creates a user and a new organization with the user as Owner. | M   |
| AUTH-02 | Users log in with email and password and receive a short-lived access token and a rotating refresh token.          | M   |
| AUTH-03 | Users can log out, which revokes the refresh token.                                                                | M   |
| AUTH-04 | Owners and Admins can invite members by email with a role. Invitations expire after 7 days.                        | P1  |
| AUTH-05 | A user can belong to several organizations and switch the active one.                                              | P1  |
| AUTH-06 | Password reset through a time-limited emailed link.                                                                | P1  |
| AUTH-07 | Every API request is authorized by role (§2.1) and scoped to the active organization.                              | M   |
| AUTH-08 | Failed logins are rate-limited per IP and per account.                                                             | M   |
| AUTH-09 | Organization settings: name, time zone, currency, fiscal week start, active-customer window, churn threshold.      | M   |

### 3.2 Business overview dashboard (OVR)

| ID     | Requirement                                                                                                                                                                     | Pri                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| OVR-01 | Show KPI cards for the selected period: Total Customers, Active Customers, New Customers, Returning Customers, Retention Rate, Churn Rate, Average Order Value, Historical CLV. | M                       |
| OVR-02 | Each KPI shows the change against a comparison period (previous period by default, or the same period last year).                                                               | M                       |
| OVR-03 | Revenue trend chart (daily, weekly or monthly buckets) for the selected range.                                                                                                  | M                       |
| OVR-04 | Customer acquisition trend chart (new customers per bucket).                                                                                                                    | M                       |
| OVR-05 | Each KPI has a tooltip with its definition and the exact period it covers.                                                                                                      | M                       |
| OVR-06 | Filter the dashboard by date range and customer segment.                                                                                                                        | M (date) / P1 (segment) |
| OVR-07 | Show the snapshot timestamp and a "Recompute" action (Admin and Analyst).                                                                                                       | M                       |

### 3.3 Customer management (CUS)

| ID     | Requirement                                                                                                                                                                                                                                       | Pri                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| CUS-01 | Create, read, update and delete customers. Delete is a soft delete, with a separate GDPR-style hard delete (CUS-10).                                                                                                                              | M                         |
| CUS-02 | Customer fields: external ID, first/last name, email, phone, city/region/country, registration date, tags, custom attributes (JSON), marketing consent flag.                                                                                      | M                         |
| CUS-03 | Paginated, sortable, searchable list (name, email, external ID) with filters for segment, total-spend range, last-purchase range and tag.                                                                                                         | M                         |
| CUS-04 | Customer profile page: personal info, registration date, KPIs (total spending, order count, purchase frequency, AOV, first/last purchase date, days since last purchase), current RFM segment and scores, purchase history, interaction timeline. | M (segment shown from P1) |
| CUS-05 | Create, read, update and delete orders, with line items optional. Fields: external ID, customer, date and time, status, gross amount, discount, tax, refunded amount, channel, items.                                                             | M                         |
| CUS-06 | Create and list interactions (type, channel, timestamp, metadata).                                                                                                                                                                                | P1                        |
| CUS-07 | CSV import of customers and orders: column mapping, validation preview, row-level error report, idempotent upsert by external ID.                                                                                                                 | M                         |
| CUS-08 | Duplicate protection: unique external ID per organization; warn on duplicate email.                                                                                                                                                               | M                         |
| CUS-09 | Customer merge (combine two records and re-point orders and interactions).                                                                                                                                                                        | P2                        |
| CUS-10 | Hard-delete or anonymize a customer on request (right to erasure). Analytics that were already aggregated stay valid.                                                                                                                             | P1                        |

### 3.4 Customer segmentation (SEG)

| ID     | Requirement                                                                                                                                                                                                                                   | Pri |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| SEG-01 | Compute Recency, Frequency and Monetary values and 1–5 scores for every customer with at least one order, as of a reference date and over a configurable look-back window.                                                                    | P1  |
| SEG-02 | Assign each scored customer to exactly one named segment using an ordered rule set. Default segments: Champions, Loyal Customers, Potential Loyalists, New Customers, Promising, Need Attention, At Risk, Can't Lose Them, Hibernating, Lost. | P1  |
| SEG-03 | Admins can edit segment rules (score ranges, order, name, color, description) and choose the scoring method (quintiles or fixed thresholds). Every change creates a new version of the configuration.                                         | P1  |
| SEG-04 | Segment overview: customer count, share of customers, share of revenue, average R/F/M per segment; R×F heat map.                                                                                                                              | P1  |
| SEG-05 | Segment migration: how many customers moved between segments from one snapshot to the next (Sankey or matrix).                                                                                                                                | P2  |
| SEG-06 | The segmentation documentation is visible in-app (methodology page).                                                                                                                                                                          | P1  |
| SEG-07 | Customers with no orders are put in a separate "No purchases" group, not scored.                                                                                                                                                              | P1  |

### 3.5 Customer behavior analytics (ANA)

All analyses accept `start`, `end`, `as_of` (where relevant) and an optional `segment` filter, and return their definition metadata (ANA-09).

| ID     | Requirement                                                                                                                                                                                   | Pri                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| ANA-01 | **Retention analysis:** period-over-period retention rate as a time series (monthly by default).                                                                                              | P1                               |
| ANA-02 | **Churn analysis:** churn rate by period; list of customers who churned in the period; churn by segment.                                                                                      | P1                               |
| ANA-03 | **Cohort analysis:** acquisition cohorts (by month of first purchase) × periods since acquisition. Values: retained-customer %, revenue per original cohort customer, cumulative revenue.     | P1                               |
| ANA-04 | **Purchase frequency:** distribution of order counts per customer, inter-purchase time distribution (median, P25, P75), repeat purchase rate, time-to-second-purchase.                        | P1                               |
| ANA-05 | **Customer journey:** lifecycle stage funnel (1st → 2nd → 3rd+ purchase), conversion between stages, median days between stages; optional interaction events before the first purchase.       | P2 ([OPEN-4])                    |
| ANA-06 | **Engagement:** interaction volume by type and channel, engaged-customer rate, and an engagement score per customer (documented formula).                                                     | P2 ([OPEN-5])                    |
| ANA-07 | **CLV:** historical CLV (measured) per customer and on average, by cohort and by segment. Predictive CLV appears only as a clearly labeled estimate with its assumptions.                     | M (historical) / P2 (predictive) |
| ANA-08 | Every chart can export its underlying data as CSV.                                                                                                                                            | P1                               |
| ANA-09 | Every analytic response includes: metric key, definition version, period, `as_of`, time zone, computed-at timestamp, and a `kind` of `measured`, `estimated` or `score` (see methodology §1). | M                                |
| ANA-10 | Small-sample warning: if a rate is computed over fewer than a minimum number of customers (default 30), flag it as low-confidence.                                                            | P1                               |

### 3.6 Recommendations (REC)

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                   | Pri |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| REC-01 | A rule engine runs after each analytics snapshot and produces recommendations.                                                                                                                                                                                                                                                                                                | P1  |
| REC-02 | Each recommendation contains: type, title, business opportunity, supporting metrics (structured), pattern explanation, suggested action, priority (High/Medium/Low), affected customer count, revenue at stake (when meaningful), and the rule ID and version.                                                                                                                | P1  |
| REC-03 | Initial rules: churn-risk customers, reactivation campaign (Hibernating/Lost with high past value), high-value customers to protect (Champions, Can't Lose Them), loyalty programme opportunity (Loyal or Potential Loyalists), purchase-frequency opportunity (one-time buyers inside the second-purchase window), retention decline alert (statistically significant drop). | P1  |
| REC-04 | Users can mark a recommendation as Acknowledged, Done or Dismissed (with a reason). The same condition does not reappear while it is dismissed unless it materially worsens.                                                                                                                                                                                                  | P1  |
| REC-05 | A recommendation links to the list of affected customers, which can be exported.                                                                                                                                                                                                                                                                                              | P1  |
| REC-06 | Admins can enable or disable rules and tune their thresholds.                                                                                                                                                                                                                                                                                                                 | P2  |

### 3.7 Reports and export (RPT)

| ID     | Requirement                                                                                                               | Pri |
| ------ | ------------------------------------------------------------------------------------------------------------------------- | --- |
| RPT-01 | Export the customer list (with current filters) to CSV, including computed metrics. Streamed so large exports work.       | M   |
| RPT-02 | Export dashboard KPIs for a period to CSV.                                                                                | P1  |
| RPT-03 | Period comparison report: two date ranges side by side, absolute and % change for each KPI.                               | P1  |
| RPT-04 | Filter any report by segment.                                                                                             | P1  |
| RPT-05 | Generate a PDF analytical report (overview, segments, retention, recommendations) for a period. Runs as a background job. | P2  |
| RPT-06 | Scheduled reports sent by email.                                                                                          | P2  |
| RPT-07 | Exports containing personal data are only available to Owner, Admin and Analyst, and are written to the audit log.        | M   |

### 3.8 Platform (PLT)

| ID     | Requirement                                                                                                                         | Pri       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------- |
| PLT-01 | Audit log of security-relevant and data-changing actions (login, member changes, imports, exports, deletes, configuration changes). | M (basic) |
| PLT-02 | Background job status: imports and analytics runs show progress and errors.                                                         | M         |
| PLT-03 | Demo data: generate a realistic synthetic dataset for a new organization.                                                           | M         |
| PLT-04 | In-app methodology page rendered from the analytics definitions.                                                                    | P1        |

---

## 4. Non-functional requirements

### 4.1 Security

- **NFR-SEC-01** Strict tenant isolation: no request can read or write another organization's data. Enforced in two independent layers (application scoping and PostgreSQL row-level security; see [02-architecture.md](02-architecture.md) §5).
- **NFR-SEC-02** Passwords hashed with Argon2id. Access tokens live 15 minutes; refresh tokens rotate, are stored hashed, and reuse revokes the whole token family.
- **NFR-SEC-03** All input is validated against schemas at the API boundary. Unknown fields are rejected.
- **NFR-SEC-04** OWASP Top 10 mitigations: parameterized queries only, CSRF protection on the cookie-based refresh endpoint, security headers (Helmet), CORS allow-list, CSV-injection escaping in exports.
- **NFR-SEC-05** The analytics service is not reachable from the internet.
- **NFR-SEC-06** Secrets come from the environment, never from the repository.

### 4.2 Privacy

- **NFR-PRV-01** Customer personal data is minimized. Analytics outputs reference customers by ID.
- **NFR-PRV-02** Support for erasure (CUS-10) and data export per organization.
- **NFR-PRV-03** The data processing role (the platform acts as processor for tenants) is documented ([OPEN-8]).

### 4.3 Performance (at assumption A1 volume)

- **NFR-PERF-01** CRUD API: p95 under 300 ms.
- **NFR-PERF-02** Dashboard endpoints served from snapshots: p95 under 500 ms.
- **NFR-PERF-03** Full analytics recompute for one tenant: under 2 minutes.
- **NFR-PERF-04** CSV import of 100k rows: under 3 minutes, without blocking the API.

### 4.4 Reliability and data quality

- **NFR-REL-01** Analytics results are reproducible: the same data, configuration and definition version give the same output.
- **NFR-REL-02** Each metric definition has a version. A changed definition increments the version; old snapshots keep the version they were computed with.
- **NFR-REL-03** Daily automated database backups (deployment concern; documented for M9).
- **NFR-REL-04** Failed background jobs are retried with backoff and surface a visible error.

### 4.5 Maintainability

- **NFR-MNT-01** TypeScript strict mode; Python type hints checked with mypy.
- **NFR-MNT-02** Lint and format in CI (ESLint, Prettier, Ruff).
- **NFR-MNT-03** Test coverage of at least 80% for analytics calculation modules and at least 70% for API service code.
- **NFR-MNT-04** OpenAPI document generated from the same schemas that validate requests.

### 4.6 Usability and accessibility

- **NFR-UX-01** WCAG 2.1 AA for core flows. Charts have text alternatives (data table view) and do not rely on color alone.
- **NFR-UX-02** Every metric shows its definition on hover or focus.
- **NFR-UX-03** Empty states explain what data is needed to unlock each analysis.

### 4.7 Observability

- **NFR-OBS-01** Structured JSON logs with request ID and organization ID (never personal data).
- **NFR-OBS-02** Health and readiness endpoints for each service.
- **NFR-OBS-03** Per-run analytics timing and row counts are recorded.

---

## 5. External interfaces

- **UI:** single-page React app (screens: Login/Signup, Overview, Customers, Customer Profile, Segments, Analytics (Retention, Cohorts, Frequency, CLV, Journey, Engagement), Recommendations, Reports, Imports, Settings, Methodology).
- **API:** REST/JSON over HTTPS, versioned under `/api/v1` ([04-api-spec.md](04-api-spec.md)).
- **File interfaces:** CSV import (UTF-8, comma or semicolon, header row) and CSV export (UTF-8 with BOM for Excel compatibility).
- **Email:** transactional email for invites and password reset (P1, provider [OPEN-9]).

## 6. Data requirements

- Money is stored as integer minor units (cents) together with the organization's ISO-4217 currency code.
- Timestamps are stored in UTC (`timestamptz`). Period bucketing uses the organization's IANA time zone.
- Revenue for analytics is **net revenue** = gross − discount − refunded (tax excluded by default; [OPEN-3]).
- Only orders with status `completed` (and `partially_refunded`) count for purchase metrics. `cancelled` and `fully_refunded` orders are excluded.

## 7. Out of scope (initial releases)

CRM pipelines and deals; sending marketing email or SMS; generative-AI insights; real-time streaming analytics; multi-currency; white-labeling; a mobile native app; billing and subscriptions for the SaaS itself (stubbed until [OPEN-10]).

## 8. Acceptance at product level (MVP)

A new user can sign up, load demo data or import a CSV of customers and orders, see a correct Business Overview for a chosen period with documented definitions, browse customer profiles with purchase history and spending metrics, and export the customer list. A second organization cannot see any of the first organization's data, and automated tests prove it.

---

## 9. Missing requirements and open questions

### 9.1 Decisions (2026-11-15)

| #                 | Decision                                                                                                                                                                                                                                                                      | Status           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| OPEN-15           | **Portfolio project, production-grade foundations.** Security, tests and tenant isolation are done properly. No SaaS billing; compliance limited to GDPR-style design (OPEN-8 default).                                                                                       | Decided          |
| OPEN-1            | **Inactivity-based churn for every business type.** Subscription (cancellation-based) churn and MRR are P2.                                                                                                                                                                   | Decided          |
| OPEN-3            | **Net revenue = gross − discount − refunded, excluding tax.** Refunds are attributed to the original order date, so past periods can change after a refund; snapshots record their `data_version`. Shipping is treated as part of gross unless the import maps it separately. | Decided          |
| OPEN-2            | **CSV import + REST API** in the MVP. Integrations with outside platforms after the MVP, none scheduled yet.                                                                                                                                                                  | Decided          |
| OPEN-6            | **Industry presets, editable in settings** (values in [05-analytics-methodology.md](05-analytics-methodology.md) §4.4).                                                                                                                                                       | Decided          |
| OPEN-7            | **Guest orders supported**: counted in revenue, orders and AOV; excluded from customer metrics; guest share shown.                                                                                                                                                            | Decided          |
| OPEN-14           | **English UI, i18n-ready** (translatable strings, locale-aware number/date formatting).                                                                                                                                                                                       | Decided          |
| OPEN-13           | **PaaS (Render, Railway or Fly.io) running the Docker images, with managed PostgreSQL.** Provider chosen in M9.                                                                                                                                                               | Decided          |
| OPEN-10           | No pricing or plan limits (follows from OPEN-15).                                                                                                                                                                                                                             | Decided          |
| OPEN-8, 9, 11, 12 | Proposed defaults below are adopted: GDPR-style design, SMTP abstraction with Mailpit locally, 24-month snapshot / 12-month audit retention, email/password auth only.                                                                                                        | Adopted defaults |
| OPEN-4, 5         | Journey and engagement scope stays open; proposed defaults apply unless revisited before M6.                                                                                                                                                                                  | Open until M6    |

### 9.2 Original questions

Each had a **proposed default** so work could proceed without an answer.

| #       | Question                                                                                                                                        | Why it matters                                                          | Proposed default                                                                            | Needed by |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------- |
| OPEN-1  | Do subscription businesses need contractual churn (explicit cancellation dates, MRR), or is inactivity-based churn enough at first?             | Contractual churn needs a `subscriptions` table and different formulas. | Inactivity-based only; add subscriptions in P2.                                             | M5        |
| OPEN-2  | How does data get in beyond CSV? Which integrations come first (Shopify, Stripe, WooCommerce, Square)?                                          | Drives the ingestion design and external ID strategy.                   | CSV and REST API only until after MVP.                                                      | M2        |
| OPEN-3  | Revenue basis: net of tax? net of shipping? Are refunds attributed to the order date or the refund date?                                        | Changes every revenue KPI.                                              | Net of discounts and refunds, excluding tax; refunds attributed to the original order date. | M2        |
| OPEN-4  | What is a "customer journey" for these businesses? Purchase lifecycle only, or touchpoints (web visits, campaigns)?                             | Touchpoints need event ingestion we don't have.                         | Lifecycle-stage funnel from purchases, plus interactions where they exist.                  | M6        |
| OPEN-5  | What counts as engagement, and which interaction types do tenants actually have?                                                                | The score formula depends on available events.                          | Fixed set of interaction types with configurable weights.                                   | M6        |
| OPEN-6  | Default thresholds: active window (90 days?), churn threshold (180 days?). Should they differ by industry (a restaurant vs. a furniture store)? | Purchase cycles vary a lot by vertical.                                 | Defaults by industry preset chosen at signup, editable in settings.                         | M3        |
| OPEN-7  | Must anonymous / guest orders (no customer) be supported?                                                                                       | They affect revenue totals but not customer metrics.                    | Allowed; included in revenue, excluded from customer metrics; share shown.                  | M2        |
| OPEN-8  | Which privacy regimes apply (GDPR, CCPA, LGPD, local law)? Where must data be hosted?                                                           | Affects retention policy, DPA, hosting region.                          | Design for GDPR (erasure, export, minimization); hosting region TBD.                        | M9        |
| OPEN-9  | Email provider for invites and password reset?                                                                                                  | Integration choice.                                                     | Provider-agnostic SMTP interface; Mailpit locally.                                          | M8        |
| OPEN-10 | SaaS pricing / plan limits (customers per plan, seats)?                                                                                         | May require usage metering.                                             | No limits enforced; data model leaves room for a `plan` field.                              | Post-MVP  |
| OPEN-11 | Data retention for tenants: how long do we keep snapshots and audit logs?                                                                       | Storage and compliance.                                                 | Snapshots 24 months, audit log 12 months.                                                   | M9        |
| OPEN-12 | Is SSO (Google, Microsoft) needed for launch?                                                                                                   | Auth design.                                                            | Email/password at launch; OAuth later.                                                      | P2        |
| OPEN-13 | Deployment target (a single VM, a PaaS like Render/Fly, a cloud provider)?                                                                      | Infra work in M9.                                                       | Single VM or PaaS with managed PostgreSQL.                                                  | M9        |
| OPEN-14 | Language and locale of the UI (English only? Spanish?) and number/date formats.                                                                 | i18n set-up is cheaper early.                                           | English UI with i18n-ready strings; locale-aware formatting.                                | M1        |
| OPEN-15 | Is this a portfolio project or a product with real customers on a deadline?                                                                     | Determines how far to go on hardening, billing and compliance.          | Portfolio quality with production-grade foundations.                                        | Now       |

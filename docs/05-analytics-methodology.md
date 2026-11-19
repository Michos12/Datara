# 05 — Analytics Methodology

This document is the single source of truth for every metric in Customer Insights. The analytics service keeps a machine-readable copy (`services/analytics/insights/definitions/*.yaml`). Every definition has a **key** and a **version**. Changing a formula increments the version; stored snapshots keep the version they were computed with (NFR-REL-02).

---

## 1. Principles

1. **Every number has a period and a reference date.** A metric is meaningless without "over what time" and "as of when". Both appear in every API response and on every UI tooltip.
2. **Measured, estimated and score are labeled.**
   - `measured` — computed directly from recorded transactions (revenue last month).
   - `estimated` — relies on a model or assumption about the future (predicted CLV). Shown with an "Estimate" badge, its assumptions, and never mixed into measured KPIs.
   - `score` — a constructed index (RFM scores, engagement score). Deterministic, but its scale is a design choice, not a fact.
3. **Incomplete periods are never shown as if complete.** The current month is marked "to date" and excluded from trend comparisons by default. Cohort cells that have not finished are `null`, not 0.
4. **Small samples are flagged.** Any rate with a denominator below 30 carries a `LOW_SAMPLE` warning. Recommendations require larger minimums (§9).
5. **Calculations are pure and reproducible.** Same input data + configuration + definition version ⇒ identical output.
6. **SQL for aggregation, Pandas for logic.** Filtering, joining and per-customer aggregation happen in SQL; ranking, pivoting, distributions and statistical tests happen in Pandas/NumPy.

## 2. Time conventions

| Rule                   | Detail                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage                | UTC `timestamptz`.                                                                                                                                                |
| Business date          | `ordered_at` converted to the organization time zone, then truncated to date.                                                                                     |
| Periods                | Half-open `[start, end)` in business dates. A "month" is a calendar month in the org time zone. Weeks start on the org's configured `weekStart` (default Monday). |
| Reference date `as_of` | The last business date included. Defaults to `end − 1 day`. Recency = `as_of − last_order_date` in days.                                                          |
| Comparison period      | `previous_period` = the period of equal length immediately before; `previous_year` = same dates one year earlier.                                                 |
| "To date" periods      | If `end > today`, the period is partial; trends mark it and KPIs say "to date".                                                                                   |

## 3. Data preparation and cleaning

Run at the start of every analytics job; results go to `analytics_runs.data_quality` and the data-quality report (`GET /analytics/data-quality`).

| Step                     | Rule                                                                              | Action                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Countable orders         | `status ∈ {COMPLETED, PARTIALLY_REFUNDED}` and `deleted_at IS NULL`               | Others excluded from all purchase metrics.                                                                 |
| Net revenue              | `net = gross − discount − refunded` (tax excluded)                                | Refunds are attributed to the original order date ([OPEN-3]).                                              |
| Zero-value orders        | `net = 0`                                                                         | Counted as orders (they are visits/purchases), contribute 0 revenue; count reported.                       |
| Future-dated orders      | `ordered_at > now + 1 day`                                                        | Excluded and reported. (Also blocked at the API.)                                                          |
| Guest orders             | `customer_id IS NULL`                                                             | Included in revenue, order counts and AOV; excluded from customer metrics. Share reported.                 |
| Soft-deleted customers   | `deleted_at IS NOT NULL`                                                          | Excluded with their orders from customer metrics; their revenue stays in revenue totals (it happened).     |
| Anonymized customers     | `anonymized_at IS NOT NULL`                                                       | Included (amounts and dates retained); no personal fields in outputs.                                      |
| Duplicate orders         | same customer, same `ordered_at` to the second, same net, different `external_id` | Kept, but flagged as suspected duplicates in the report (not silently dropped).                            |
| Outliers                 | Order net > P99.9 × 10 for the tenant                                             | Kept; flagged in the report for review. Analytics show medians alongside means so outliers do not mislead. |
| Customers without orders | —                                                                                 | Counted in Total Customers; lifecycle `PROSPECT`; not RFM-scored.                                          |

**Exploratory data analysis (EDA)** artifacts produced each run for the data-quality page and for internal validation: row counts by status, monthly order and revenue volume, spend distribution (with skewness; usually log-normal-like), orders-per-customer distribution, Pareto curve (revenue share of top 10% / 20% of customers), missing-field rates.

## 4. Core customer & business metrics

Notation: `P = [s, e)` is the analysis period; `O(P)` the countable orders with business date in `P`; `C(P)` the distinct customers in `O(P)` (guests excluded); `first(c)` the business date of customer `c`'s first countable order ever; `last(c, d)` the last countable order on or before date `d`.

| Key                       | Name                            | Definition                                                                                                                                   | Kind     |
| ------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `total_customers`         | Total Customers                 | Non-deleted customer records created on or before `e − 1`.                                                                                   | measured |
| `customers_with_purchase` | Purchasing Customers (lifetime) | Customers with `first(c) < e`.                                                                                                               | measured |
| `active_customers`        | Active Customers                | Customers with `as_of − last(c, as_of) ≤ W`, where `W` = `settings.activeWindowDays` (industry preset, §4.4).                                | measured |
| `buyers`                  | Buyers in Period                | `                                                                                                                                            | C(P)     | `. Always equals New + Returning. | measured |
| `new_customers`           | New Customers                   | Customers with `first(c) ∈ P`. "New" means _first purchase_, not registration; registration-based count is available as `new_registrations`. | measured |
| `returning_customers`     | Returning Customers             | Customers in `C(P)` with `first(c) < s`.                                                                                                     | measured |
| `revenue_net`             | Net Revenue                     | `Σ net` over `O(P)` (guests included).                                                                                                       | measured |
| `orders`                  | Orders                          | `                                                                                                                                            | O(P)     | `.                                | measured |
| `aov`                     | Average Order Value             | `revenue_net / orders` over `P`. Undefined (null) when `orders = 0`. Median order value reported alongside.                                  | measured |
| `purchase_frequency`      | Purchase Frequency              | `orders from identified customers in P / buyers` (orders per buying customer in the period).                                                 | measured |
| `revenue_per_customer`    | Revenue per Buyer               | `revenue_net from identified customers / buyers`.                                                                                            | measured |

### 4.1 Retention rate (period-over-period)

For period `P` with length `L` and the preceding period `P₋₁ = [s − L, s)`:

```
base(P)      = C(P₋₁)                         customers who bought in the previous period
retained(P)  = base(P) ∩ C(P)                 of those, who bought again in P
retention(P) = |retained(P)| / |base(P)|
```

- Key: `retention_rate`, kind: measured, version 1.
- Interpretation: "Of the customers who bought last month, X% bought again this month."
- **Grain matters.** For businesses with long purchase cycles (furniture, services) monthly retention looks low by nature. The UI recommends a grain based on the tenant's median inter-purchase time (if median gap > 60 days, default to quarterly).

### 4.2 Churn (inactivity-based, non-contractual)

A customer has no cancellation event in non-contractual businesses, so churn is **defined by inactivity**:

```
C_days            = settings.churnDays        (industry preset, §4.4)
churn_date(c)     = last(c) + C_days          (if no later order happens)
alive at d        = first(c) ≤ d  and  d − last(c, d) ≤ C_days
churned(P)        = customers whose churn_date falls in P (no order between last(c) and churn_date)
base(P)           = customers alive at s
churn_rate(P)     = |churned(P)| / |base(P)|
```

- Key: `churn_rate`, kind: measured (the threshold is a business definition, applied to recorded facts), version 1.
- **Churn is recognised with delay**: a customer who stopped buying in January is counted as churned in July (with a 180-day threshold). The UI explains this.
- **Churn rate ≠ 1 − retention rate** in this design. Retention measures repeat buying between adjacent periods; churn measures crossing the inactivity threshold. Showing both is intentional; the tooltip explains the difference. Presenting `1 − retention` as "churn" would overstate churn badly for infrequent buyers.
- A churned customer who buys again is **reactivated** (`reactivated_customers` metric) and becomes alive again.
- **Series** use whole buckets (weeks, months, quarters): a requested range is widened to bucket boundaries so every bucket is compared with a full previous one. Each rate carries a 95% Wilson interval and the low-sample flag (§9).
- **Churned-customer list** for a range: customers whose churn date falls in it (and has passed). Over one bucket this is exactly the set the churn rate counts.
- **Churn by segment**: customers alive at the range start, grouped by their RFM segment recomputed as of the day before the range (active rules), so the breakdown shows where they stood before lapsing.
- Contractual (subscription) churn — `cancelled subscriptions / subscriptions active at start` — is deferred until a `subscriptions` model exists ([OPEN-1]).

### 4.3 Lifecycle status (per customer, at `as_of`)

| Status     | Rule                      |
| ---------- | ------------------------- |
| `PROSPECT` | No countable orders.      |
| `ACTIVE`   | Recency ≤ `W`.            |
| `AT_RISK`  | `W` < recency ≤ `C_days`. |
| `CHURNED`  | Recency > `C_days`.       |

### 4.4 Industry presets (decision OPEN-6)

Chosen at signup from `organizations.industry`; every value is editable in settings. Changing a value triggers a recompute, and the run records the values used.

| Industry                                 | Active window `W` (days) | Churn threshold `C_days` | Default trend grain | RFM recency cut points (days, scores 5→2) |
| ---------------------------------------- | ------------------------ | ------------------------ | ------------------- | ----------------------------------------- |
| Restaurant                               | 30                       | 90                       | week                | 14 / 30 / 60 / 90                         |
| Retail (physical)                        | 90                       | 180                      | month               | 30 / 90 / 180 / 365                       |
| E-commerce                               | 90                       | 180                      | month               | 30 / 90 / 180 / 365                       |
| Subscription (inactivity-based until P2) | 45                       | 90                       | month               | 30 / 45 / 90 / 180                        |
| Services                                 | 180                      | 365                      | quarter             | 60 / 180 / 365 / 540                      |
| Other / not set                          | 90                       | 180                      | month               | 30 / 90 / 180 / 365                       |

These are starting values, not facts about any one business. After the first analytics run, the settings page shows the tenant's median inter-purchase gap and P75 gap, and suggests changes if `W` is below the median gap or `C_days` is below twice the P75 gap.

## 5. Customer Lifetime Value

### 5.1 Historical CLV (measured)

```
historical_clv(c, as_of) = Σ net of c's countable orders with business date ≤ as_of
```

- Averages are over customers with at least one order. Mean **and** median are shown (spend is highly skewed).
- Raw lifetime averages mix customers of very different tenure. To make values comparable, the main CLV view is **CLV at N months by cohort**:
  `clv_12m(cohort) = Σ net in months 0..11 since acquisition / cohort size`, shown only for cohorts with 12 complete months.

### 5.2 Predicted CLV (estimated, P2)

Two options, both labeled `estimated` with assumptions displayed:

1. **Simple heuristic** (first): `expected annual revenue = AOV × annual purchase frequency`; `predicted_clv = expected annual revenue × expected lifetime (years)`, where expected lifetime = `1 / annual churn rate`. Assumes stationarity; shown with a range using the 25th–75th percentile of AOV and frequency.
2. **Probabilistic model** (later): BG/NBD for purchase counts + Gamma-Gamma for spend (e.g. `pymc-marketing`). Only enabled after a **backtest** (calibrate on data up to T−6 months, compare predicted vs actual purchases over the holdout) with the error reported in-app.

Revenue-based CLV is not profit. Gross margin is not collected; if a tenant sets an average margin in settings, a "margin-adjusted" figure can be shown, labeled as such.

## 6. RFM segmentation

### 6.1 Inputs (as of `as_of`, look-back window `Lb` = `lookback_days`, default 365)

| Dimension         | Value                                              | Note                                                      |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Recency `R_raw`   | `as_of − last(c, as_of)` in days                   | All-time last order. Lower is better.                     |
| Frequency `F_raw` | Count of countable orders in `(as_of − Lb, as_of]` |                                                           |
| Monetary `M_raw`  | Σ net in `(as_of − Lb, as_of]`                     | Total, not average, so it reflects value to the business. |

Customers with `F_raw = 0` (no orders in the window but older orders) are **not ranked**; they get `R = F = M = 1` directly so they do not distort the quantiles. Customers with no orders at all are `No purchases` (SEG-07).

### 6.2 Scoring methods

**Quintile (default).** For the ranked population:

```
pct = rank(x, method="average", pct=True)     # ties share the same percentile
score = ceil(pct × 5)                         # 1..5
R score uses -R_raw (more recent = higher score)
```

Caveat (documented in-app): frequency is very tied — often 50–70% of customers have exactly 1 order. With average-rank ties, all one-time buyers get the same F score, so F quintiles are not equal-sized. That is the honest result; we do not split ties arbitrarily.

**Fixed thresholds (recommended for frequency).** Admin-defined cut points, e.g.:

| Score                | 1     | 2       | 3      | 4     | 5    |
| -------------------- | ----- | ------- | ------ | ----- | ---- |
| F (orders in window) | 1     | 2       | 3      | 4–5   | 6+   |
| R (days)             | > 365 | 181–365 | 91–180 | 31–90 | ≤ 30 |

Industry presets supply default thresholds. A tenant may mix (quintiles for M, thresholds for R/F).

### 6.3 Segment rules (default configuration, version 1)

Rules are evaluated **in order; the first match wins.** Validation guarantees every (R, F) cell is covered.

| #   | Segment             | Rule                | Meaning                              |
| --- | ------------------- | ------------------- | ------------------------------------ |
| 1   | Champions           | R 4–5, F 4–5        | Bought recently, buy often.          |
| 2   | Can't Lose Them     | R 1–2, F 4–5, M 4–5 | Were top customers, gone quiet.      |
| 3   | At Risk             | R 1–2, F 3–5        | Used to buy regularly, not recently. |
| 4   | Loyal Customers     | R 3–5, F 3–5        | Buy regularly (and not Champions).   |
| 5   | Potential Loyalists | R 4–5, F 2          | Recent, second purchase made.        |
| 6   | New Customers       | R 5, F 1            | Very recent first purchase.          |
| 7   | Promising           | R 4, F 1            | Recent first purchase.               |
| 8   | Need Attention      | R 3, F 1–2          | Middling recency, low frequency.     |
| 9   | Hibernating         | R 2, F 1–2          | Low recency and frequency.           |
| 10  | Lost                | R 1, F 1–2          | Lowest recency and frequency.        |

The spec's required groups (Champions, Loyal, New, At Risk, Hibernating, Lost) are all present; the extra four make the grid complete without forcing customers into misleading groups. Tenants can merge segments by editing rules.

Option: "New Customers" can be redefined as `first(c) within the last N days` (`rule.type = "first_order_within"`), which is closer to the everyday meaning; RFM scores are still computed for them.

### 6.4 Outputs

Per customer: raw R/F/M, scores, segment key, config version. Per segment: count, % of scored customers, % of trailing-window revenue, mean/median R/F/M, mean historical CLV. R×F matrix of counts. Segment migration matrix between two runs (P2).

## 7. Cohort analysis

- **Cohort** = calendar month (org time zone) of `first(c)`. Option: registration month, for businesses that register before buying.
- **Period index** `k` = whole months between the cohort month and the order month (0 = acquisition month).
- **Cells** (computed on read from the cached organization frame and served through the query cache; the `analytics_cohort_cells` table in the data model is not needed yet):
  - `cohort_size` = customers in the cohort
  - `active_customers(c, k)` = distinct cohort customers with ≥1 order in month `cohort + k`
  - `net_cents(c, k)` = their net revenue in that month
- **Derived matrices** (computed on read):
  - Retention: `active / size` (k=0 is always 100%)
  - Revenue per original customer: `net / size`
  - Cumulative revenue per customer: running sum over `k`
- A cell is shown only if month `cohort + k` is complete before `as_of`; otherwise `null`.
- Cohorts with size < 30 are shown with a low-sample marker; the weighted average row is weighted by cohort size.
- Segment filter applies to the customer's segment at `as_of` (stated in the UI, because segment is a current property applied retroactively).

## 8. Purchase frequency, journey and engagement

### 8.1 Purchase frequency

> Implemented in M6 (`insights/metrics/value.py`). Every figure is for the customers whose first purchase falls in the selected acquisition window, followed up to today. All counts on the Frequency page use **purchase occasions** (same-day orders merged), including the histogram and the repeat rate, so they always agree with the time to second purchase. Kaplan–Meier is a small NumPy/pandas product-limit estimator, tested against `lifelines` 0.30 reference output; ties count events before censorings, as in `lifelines`. "Within t days" figures report alongside how many customers were acquired at least t days ago. Repeat rate by cohort adds `within90` (second purchase within 90 days), shown only once the whole cohort is 90 days old.

- **Orders-per-customer distribution** (lifetime, as of `as_of`): histogram with buckets 1, 2, 3, 4, 5, 6–10, 11+.
- **Repeat purchase rate** = customers with ≥2 orders / customers with ≥1 order (lifetime, as of `as_of`; also by acquisition cohort).
- **Inter-purchase time**: gaps in days between consecutive _purchase occasions_ (orders by the same customer on the same business date are merged into one occasion). Reported: median, P25, P75, and histogram. The median gap per customer is stored (`median_gap_days`) for churn-risk rules.
- **Time to second purchase** is right-censored (many customers have not made a second purchase _yet_). We use a **Kaplan–Meier estimator** to report "% of customers who make a second purchase within 30 / 60 / 90 / 180 days". Computing a simple average over only those who did buy twice would be biased downward. Kind: measured (non-parametric estimator over observed data; censoring disclosed).

### 8.2 Customer journey (P2, scope per [OPEN-4])

> Implemented in M6 with the proposed default. Population: customers whose customer-since date (§4, earliest of registration and first purchase) falls in the window. Stages count purchase occasions to date; "Active" is a share of first-time buyers (last purchase within the active window today), not a further step. Stage timing is the Kaplan–Meier median (null while fewer than half have reached the next stage) with the observed median among those who did. Interaction types before the first purchase are counted per customer, in the 30 days up to and including the first purchase day.

Lifecycle funnel from purchase data, per acquisition cohort window:
`Registered → 1st purchase → 2nd purchase → 3rd+ purchase → Active at as_of`
with stage conversion rates and median days between stages (Kaplan–Meier for stage timing). If interactions exist, show the most common interaction types in the 30 days before the first purchase (descriptive only, no attribution claims).

### 8.3 Engagement (P2, scope per [OPEN-5])

> Implemented in M6. Weights live in organization settings (`settings.engagement = { weights, cap }`, lower-case type keys, 0–10 each; cap 1–100, default 10 per type per 90 days); every response echoes the weights used, and the formula version is `engagement_score` v1. Defaults also set EMAIL_SENT 0 and OTHER 1. The engaged-customer rate's numerator is alive customers with an interaction (of any weight), so it is a proper share. Customers with raw = 0 have no score (null in the snapshot), not 0. The nightly snapshot stores each customer's score (`analytics_customer_metrics.engagement_score`), shown on the profile. The correlation check: alive customers 90 days before the reference date, their score then vs. purchase days since; ρ is null below 30 customers.

- **Engaged-customer rate** = customers with ≥1 interaction in the last 90 days / customers alive at `as_of`.
- **Engagement score** (kind: `score`, 0–100):
  ```
  raw(c)   = Σ_type weight(type) × min(count(c, type, last 90 days), cap(type))
  score(c) = percentile rank of log(1 + raw(c)) among customers with raw > 0, × 100
  ```
  Default weights: EMAIL_OPENED 1, EMAIL_CLICKED 3, WEBSITE_VISIT 1, CAMPAIGN_RESPONSE 4, REVIEW 5, LOYALTY_SIGNUP 5, SUPPORT_TICKET 0 (neutral, reported separately). Weights are configurable and versioned. The score is relative within the tenant.
- Correlation between engagement score and subsequent 90-day purchase is reported as a sanity check (Spearman ρ), explicitly described as correlation, not causation.

## 9. Statistical methods

| Use                                          | Method                                                                                                              | Guard rails                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Is retention significantly lower than usual? | Two-proportion z-test: current period vs pooled previous 3 periods.                                                 | Both bases ≥ 100; flag only if p < 0.05 **and** drop ≥ 3 percentage points (practical significance). |
| Confidence intervals for rates               | Wilson score interval (95%). Shown on hover for rates.                                                              | —                                                                                                    |
| KPI change vs previous period                | Plain difference; no significance claim for counts and money.                                                       | Partial periods excluded.                                                                            |
| Time-to-event                                | Kaplan–Meier (via `lifelines`, or a small NumPy implementation).                                                    | Censoring disclosed.                                                                                 |
| Skewed money distributions                   | Median and P25/P75 shown next to mean.                                                                              | —                                                                                                    |
| Multiple comparisons                         | Recommendation rules test a fixed, small set of hypotheses per run; no data dredging across all segments × metrics. | Documented per rule.                                                                                 |

## 10. Recommendation rules (initial set, version 1)

> Implemented in M7 (`insights/recommendations/`). Rules run at the end of every snapshot, in the same transaction that writes it; a rule that raises is skipped and reported in the run's `stats.rule_errors`, so one faulty rule never blocks the others or the snapshot. Notes on the details:
>
> - Rules that name segments use the default keys (`champions`, `cant_lose_them`, `loyal`, `potential_loyalists`, `hibernating`, `lost`); a tenant that renames those keys does not trigger them.
> - Trailing-12-month revenue (the impact denominator) is all net revenue in the 365 days up to `as_of`, guest orders included. Per-customer values are stored with the affected list, which is ordered by them.
> - `second_purchase_window` uses purchase occasions (as on the Frequency page) and the P25–P75 of days to the second purchase among returning customers; it needs 30 of them.
> - `retention_decline` compares the last complete month (quarter when the median gap exceeds 60 days, §4.1) with the pooled previous three, using a one-sided test (H1: retention is lower). Its scope is the grain, so a switch from monthly to quarterly is a different recommendation.
> - Lifecycle extras: `DONE` reopens after 30 days (or when revenue at stake grows ≥ 50% since it was marked done); an expired recommendation reopens as soon as its condition holds again; expired ones cannot be changed by users.

Each rule outputs: opportunity, structured metrics, explanation, suggested action, affected customers, `revenue_at_stake` and priority. **Revenue at stake is measured, not predicted**: it is the affected customers' net revenue in the 12 months before `as_of` ("these customers spent $X with you last year"). No revenue forecast is presented as fact.

| Key                      | Trigger                                                                                                                                              | Affected customers                       | Suggested action                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `churn_risk_high_value`  | Customers with F ≥ 4 or M ≥ 4, lifecycle not CHURNED, ≥ 3 orders, and recency > 1.5 × their own median gap and > 30 days. Fire if ≥ 10 customers.    | Those customers                          | Personalised win-back offer within 14 days; contact the top 30 by spend directly.                             |
| `reactivation_campaign`  | Hibernating + Lost customers with historical CLV ≥ tenant P75 and marketing consent. Fire if ≥ 20.                                                   | Those customers                          | Reactivation campaign with an incentive; measure response against a holdout group.                            |
| `protect_champions`      | Champions + Can't Lose Them account for ≥ 30% of trailing-12-month revenue.                                                                          | Champions, Can't Lose Them               | VIP treatment: early access, loyalty tier, thank-you outreach. Can't Lose Them first.                         |
| `loyalty_programme`      | Loyal + Potential Loyalists ≥ 15% of active customers.                                                                                               | Those customers                          | Introduce or promote a points/tier programme to move them toward Champions.                                   |
| `second_purchase_window` | One-time buyers whose days since first purchase are within the [P25, P75] window of the tenant's time-to-second-purchase distribution. Fire if ≥ 20. | Those customers                          | Post-purchase nudge (recommendation, small incentive) during the window when second purchases usually happen. |
| `retention_decline`      | z-test of §9 fires on monthly (or tenant grain) retention.                                                                                           | Customers in the base who did not return | Investigate causes (product, price, service changes in the period); review the churned list.                  |

**Priority**

```
impact   = revenue_at_stake / trailing_12m_revenue          (share of revenue)
priority = HIGH   if impact ≥ 5%  or rule = retention_decline with drop ≥ 5 points
           MEDIUM if impact ≥ 1%
           LOW    otherwise
priority_score = impact × confidence, confidence = min(1, affected_customers / 100)
```

**Lifecycle**

- `fingerprint = rule_key + ":" + scope` (scope e.g. segment key). One open recommendation per fingerprint.
- Each run updates `last_detected_at`, metrics and affected customers of an existing open recommendation.
- If the condition no longer holds for 2 consecutive runs → `EXPIRED`.
- `DISMISSED` stays dismissed for 90 days unless `revenue_at_stake` grows by ≥ 50%.

## 11. Verification strategy

1. **Golden fixtures:** tiny hand-built datasets (10–30 customers) with expected values computed by hand in the test file, for every metric, including edge cases: guest orders, refunds, same-day orders, DST boundaries, period edges (order at 23:59 local on the last day), empty periods.
2. **Property tests (Hypothesis):** rates in [0, 1]; `new + returning = buyers`; segment counts sum to scored customers; cohort `k=0` retention = 1; recomputation is deterministic.
3. **Synthetic ground truth:** `tools/datagen` simulates customers with known purchase rates and planted events (e.g. a churn wave in a given month, a high-value group). End-to-end tests assert that metrics detect them (retention drop appears in the right month; the planted group is mostly classified At Risk).
4. **SQL vs Pandas cross-check:** overview KPIs are computed both ways in a test and must match exactly.
5. **Definition registry test:** every metric used in an API response exists in the registry with a version and formula text.

## 12. Data retention

Defaults adopted for OPEN-11 (M9). Tenant data is pruned by each organization's nightly recompute, inside that organization's RLS context; data that belongs to no tenant is pruned by the daily `maintenance.cleanup` job.

| Data                                                           | Kept                                                                                                                        | Pruned by   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Analytics snapshots (runs, per-customer and period metrics)    | The latest 7 successful runs, plus the last run of each month for 24 months. Failed or running runs: 1 day.                 | Recompute   |
| Audit log                                                      | 12 months. The runtime role may delete only entries older than that (RLS policy); within the window the log is append-only. | Recompute   |
| Invitations                                                    | 30 days after acceptance, revocation or expiry                                                                              | Recompute   |
| Query cache                                                    | 30 days (entries for older data versions are dropped as soon as a newer result is stored)                                   | Recompute   |
| Finished background jobs                                       | 30 days                                                                                                                     | Maintenance |
| Expired or revoked refresh tokens, used or expired reset links | 7 days                                                                                                                      | Maintenance |
| Uploaded CSVs and import error reports                         | 30 days                                                                                                                     | Maintenance |
| Generated PDF reports and data exports                         | 7 days                                                                                                                      | Maintenance |

Customer, order and interaction records are kept until the organization deletes them (erasure, organization deletion).

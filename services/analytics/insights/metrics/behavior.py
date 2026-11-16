"""Retention, churn and cohort analysis (docs/05-analytics-methodology.md §4.1, §4.2, §7, §9).

Pure functions over the loader's frames, like `core`. Series reuse `core.retention` and
`core.churn` per bucket so the Behavior page and the Business Overview can never disagree.
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Any

import pandas as pd

from insights.metrics.core import (
    MIN_SAMPLE,
    Ratio,
    _identified,
    churn,
    first_purchase,
    retention,
    ts,
)
from insights.metrics.rfm import SegmentConfig, rfm
from insights.periods import Grain, Period, add_months, floor_to_grain, next_bucket

Z_95 = 1.959963984540054
QUARTERLY_GAP_DAYS = 60
"""Median gap above which monthly retention looks low by nature: recommend quarters (§4.1)."""


def wilson(successes: int, trials: int, z: float = Z_95) -> tuple[float, float] | None:
    """Wilson score interval for a proportion (§9). None when there are no trials."""
    if trials == 0:
        return None
    p = successes / trials
    denominator = 1 + z * z / trials
    centre = (p + z * z / (2 * trials)) / denominator
    margin = z * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / denominator
    # Clamp to [0, 1] and to the observed rate itself, which float rounding can cross at p = 1.
    return max(0.0, min(p, centre - margin)), min(1.0, max(p, centre + margin))


def median_gap_days(purchases: pd.DataFrame) -> float | None:
    """Median over repeat customers of their median days between purchase days."""
    p = _identified(purchases)[["customer_id", "day"]].drop_duplicates()
    p = p.sort_values(["customer_id", "day"])
    gaps = p.groupby("customer_id")["day"].diff().dt.days.dropna()
    if gaps.empty:
        return None
    per_customer = gaps.groupby(p.loc[gaps.index, "customer_id"]).median()
    return float(per_customer.median())


def recommended_grain(purchases: pd.DataFrame) -> dict[str, Any]:
    gap = median_gap_days(purchases)
    grain: Grain = "quarter" if gap is not None and gap > QUARTERLY_GAP_DAYS else "month"
    return {"grain": grain, "medianGapDays": gap}


def snap_to_grain(period: Period, grain: Grain, week_start: str = "monday") -> Period:
    """Widen a period to whole buckets, so every bucket has a full previous bucket to compare."""
    start = floor_to_grain(period.start, grain, week_start)  # type: ignore[arg-type]
    end = floor_to_grain(period.end - timedelta(days=1), grain, week_start)  # type: ignore[arg-type]
    return Period(start, next_bucket(end, grain))


def whole_buckets(period: Period, grain: Grain, week_start: str = "monday") -> list[Period]:
    snapped = snap_to_grain(period, grain, week_start)
    result: list[Period] = []
    cursor = snapped.start
    while cursor < snapped.end:
        nxt = next_bucket(cursor, grain)
        result.append(Period(cursor, nxt))
        cursor = nxt
    return result


def _rate(ratio: Ratio) -> dict[str, Any]:
    interval = wilson(ratio.numerator, ratio.denominator)
    return {
        "rate": ratio.value,
        "low": interval[0] if interval else None,
        "high": interval[1] if interval else None,
        "lowSample": ratio.low_sample,
    }


def retention_series(
    purchases: pd.DataFrame, buckets: list[Period], today: date
) -> list[dict[str, Any]]:
    """retention(P) per bucket against the bucket before it (§4.1), with a 95% Wilson interval.

    Buckets are whole weeks, months or quarters, so `Period.previous()` is the previous bucket.
    """
    rows = []
    for bucket in buckets:
        ratio = retention(purchases, bucket)
        rows.append(
            {
                "period": bucket.start.isoformat(),
                "end": bucket.end.isoformat(),
                "base": ratio.denominator,
                "retained": ratio.numerator,
                **_rate(ratio),
                "partial": bucket.is_partial(today),
            }
        )
    return rows


def reactivated(purchases: pd.DataFrame, period: Period, churn_days: int) -> set[str]:
    """Customers who bought in P after a gap longer than the churn threshold: they had churned
    and came back (§4.2)."""
    p = _identified(purchases)[["customer_id", "day"]].drop_duplicates()
    p = p.sort_values(["customer_id", "day"])
    prev = p.groupby("customer_id")["day"].shift(1)
    back = (
        prev.notna()
        & ((p["day"] - prev) > pd.Timedelta(days=churn_days))
        & (p["day"] >= ts(period.start))
        & (p["day"] < ts(period.end))
    )
    return set(p.loc[back, "customer_id"])


def churn_series(
    purchases: pd.DataFrame, buckets: list[Period], churn_days: int, today: date
) -> list[dict[str, Any]]:
    """Churn rate per bucket (§4.2): churn events recognised so far, over customers alive at the
    bucket start, plus reactivations."""
    rows = []
    for bucket in buckets:
        as_of = min(bucket.last_day, today)
        if as_of < bucket.start:
            as_of = bucket.start
        ratio = churn(purchases, bucket, churn_days, as_of)
        rows.append(
            {
                "period": bucket.start.isoformat(),
                "end": bucket.end.isoformat(),
                "base": ratio.denominator,
                "churned": ratio.numerator,
                **_rate(ratio),
                "reactivated": len(reactivated(purchases, bucket, churn_days)),
                "partial": bucket.is_partial(today),
            }
        )
    return rows


def churned_customers(
    purchases: pd.DataFrame, period: Period, churn_days: int, as_of: date
) -> pd.DataFrame:
    """Customers whose churn date falls in P and has passed by `as_of` (§4.2), with the facts
    behind each churn date. Over one bucket these are exactly the customers `churn` counts
    (a churn date in P implies the customer was alive at its start whenever the threshold is
    longer than the bucket); over a longer range, everyone who lapsed during it.

    Columns: customer_id, last_purchase, churn_date, orders, net (lifetime up to last purchase).
    Sorted by lifetime net revenue, highest first: the most valuable losses come first.
    """
    p = _identified(purchases)
    p = p[p["day"] <= ts(as_of)]
    days = p[["customer_id", "day"]].drop_duplicates().sort_values(["customer_id", "day"])
    threshold = pd.Timedelta(days=churn_days)
    start, end = ts(period.start), ts(period.end)

    nxt = days.groupby("customer_id")["day"].shift(-1)
    churn_date = days["day"] + threshold
    lapsed = nxt.isna() | (nxt > churn_date)
    in_period = (churn_date >= start) & (churn_date < end) & (churn_date <= ts(as_of))
    events = days[lapsed & in_period].copy()
    events["churn_date"] = events["day"] + threshold
    events = events.rename(columns={"day": "last_purchase"})
    # A customer who churned, came back and churned again within P is listed once, at the
    # latest churn.
    events = events.sort_values("churn_date").drop_duplicates("customer_id", keep="last")

    if events.empty:
        return pd.DataFrame(columns=["customer_id", "last_purchase", "churn_date", "orders", "net"])
    lifetime = p.merge(events[["customer_id", "last_purchase"]], on="customer_id")
    lifetime = lifetime[lifetime["day"] <= lifetime["last_purchase"]]
    totals = lifetime.groupby("customer_id").agg(orders=("orders", "sum"), net=("net", "sum"))
    out = events.merge(totals, left_on="customer_id", right_index=True, how="left")
    out = out.sort_values(["net", "customer_id"], ascending=[False, True])
    return out[["customer_id", "last_purchase", "churn_date", "orders", "net"]].reset_index(
        drop=True
    )


def churn_by_segment(
    purchases: pd.DataFrame,
    customers: pd.DataFrame,
    period: Period,
    churn_days: int,
    as_of: date,
    recency_cut_points: tuple[int, int, int, int],
    config: SegmentConfig,
) -> list[dict[str, Any]]:
    """Churn over P broken down by each customer's RFM segment on the day before P starts.

    Segments are recomputed as of that day with the active configuration, so the breakdown
    shows where churned customers stood *before* they lapsed, not where they ended up.
    """
    segment_day = period.start - timedelta(days=1)
    segmented = rfm(purchases, customers, segment_day, recency_cut_points, config)
    segment_of = dict(zip(segmented["customer_id"], segmented["segment_key"], strict=True))

    days = _identified(purchases)
    days = days[days["day"] < ts(period.start)]
    last_before = days.groupby("customer_id")["day"].max()
    alive = last_before[last_before >= ts(period.start) - pd.Timedelta(days=churn_days)].index
    churned = set(churned_customers(purchases, period, churn_days, as_of)["customer_id"])

    counts: dict[str, list[int]] = {}
    for customer in alive:
        key = segment_of.get(customer)
        bucket = counts.setdefault(key or "", [0, 0])
        bucket[0] += 1
        bucket[1] += customer in churned
    rows = []
    order = [rule.key for rule in config.rules]
    for key in [*order, ""]:
        if key not in counts:
            continue
        base, lost = counts[key]
        ratio = Ratio(lost, base)
        rows.append({"segment": key or None, "base": base, "churned": lost, **_rate(ratio)})
    return rows


def cohort_months(start: date, end: date) -> list[date]:
    """First days of the calendar months whose start falls in [start, end)."""
    cursor = start.replace(day=1) if start.day == 1 else add_months(start.replace(day=1), 1)
    months = []
    while cursor < end:
        months.append(cursor)
        cursor = add_months(cursor, 1)
    return months


def cohort_matrix(
    purchases: pd.DataFrame, months: list[date], max_periods: int, today: date
) -> dict[str, Any]:
    """Acquisition cohorts by month of first purchase × months since acquisition (§7).

    A cell exists only once its calendar month is over (before `today`); incomplete cells are
    null, never 0. k = 0 is the acquisition month, so its retention is 100% once complete.
    """
    first = first_purchase(purchases)
    p = _identified(purchases)
    cohort_of = first.dt.year * 12 + first.dt.month - 1  # month index of the first purchase
    p = p.assign(cohort=p["customer_id"].map(cohort_of))
    p = p.assign(k=p["day"].dt.year * 12 + p["day"].dt.month - 1 - p["cohort"])
    p = p[(p["k"] >= 0) & (p["k"] < max_periods)]
    active = p.groupby(["cohort", "k"])["customer_id"].nunique()
    net = p.groupby(["cohort", "k"])["net"].sum()
    sizes = cohort_of.value_counts()

    cohorts = []
    totals_size = [0] * max_periods
    totals_active = [0] * max_periods
    totals_net = [0] * max_periods
    totals_cumulative = [0.0] * max_periods
    for month in months:
        period = month.year * 12 + month.month - 1
        size = int(sizes.get(period, 0))
        retention_values: list[float | None] = []
        revenue_values: list[float | None] = []
        cumulative_values: list[float | None] = []
        actives: list[int | None] = []
        running = 0.0
        for k in range(max_periods):
            complete = add_months(month, k + 1) <= today
            if not complete or size == 0:
                retention_values.append(None)
                revenue_values.append(None)
                cumulative_values.append(None)
                actives.append(None)
                continue
            a = int(active.get((period, k), 0))
            n = int(net.get((period, k), 0))
            running += n / size
            actives.append(a)
            retention_values.append(a / size)
            revenue_values.append(n / size)
            cumulative_values.append(running)
            totals_size[k] += size
            totals_active[k] += a
            totals_net[k] += n
            totals_cumulative[k] += running * size
        cohorts.append(
            {
                "cohort": month.strftime("%Y-%m"),
                "size": size,
                "lowSample": 0 < size < MIN_SAMPLE,
                "active": actives,
                "retention": retention_values,
                "revenuePerCustomer": revenue_values,
                "cumulativeRevenuePerCustomer": cumulative_values,
            }
        )

    def weighted(totals: list[int] | list[float]) -> list[float | None]:
        # Size-weighted over the cohorts whose cell k is complete (§7).
        return [totals[k] / totals_size[k] if totals_size[k] else None for k in range(max_periods)]

    return {
        "periods": list(range(max_periods)),
        "cohorts": cohorts,
        "average": {
            "size": sum(c["size"] for c in cohorts),
            "retention": weighted(totals_active),
            "revenuePerCustomer": weighted(totals_net),
            "cumulativeRevenuePerCustomer": weighted(totals_cumulative),
        },
    }

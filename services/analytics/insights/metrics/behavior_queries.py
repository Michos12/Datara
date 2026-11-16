"""Behavior queries: retention, churn, churned customers and cohorts, in the API envelope."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any

import pandas as pd

from insights.data.loader import OrgData
from insights.definitions import DEFINITION_VERSIONS
from insights.metrics.behavior import (
    churn_by_segment,
    churn_series,
    churned_customers,
    cohort_matrix,
    cohort_months,
    recommended_grain,
    retention_series,
    snap_to_grain,
    whole_buckets,
)
from insights.metrics.rfm import SegmentConfig
from insights.periods import Grain, Period, add_months, today_in

LOW_SAMPLE_WARNING = {
    "code": "LOW_SAMPLE",
    "message": "Some rates are based on fewer than 30 customers and can swing widely.",
}


def last_complete_months(today: date, months: int) -> Period:
    this_month = today.replace(day=1)
    return Period(add_months(this_month, -months), this_month)


def _meta(
    data: OrgData,
    metric: str,
    period: Period,
    grain: Grain,
    as_of: date,
    today: date,
    now: datetime | None,
    warnings: list[dict[str, str]],
) -> dict[str, Any]:
    return {
        "metric": metric,
        "definitionVersions": DEFINITION_VERSIONS,
        "kind": "measured",
        "period": {**period.to_dict(), "grain": grain},
        "comparePeriod": None,
        "asOf": as_of.isoformat(),
        "today": today.isoformat(),
        "timezone": data.timezone,
        "currency": data.currency,
        "settings": data.settings.to_dict(),
        "computedAt": (now or datetime.now(UTC)).isoformat(),
        "dataVersion": data.data_version,
        "warnings": warnings,
    }


def _series_period(
    data: OrgData, period: Period | None, grain: Grain | None, today: date
) -> tuple[Period, Grain, dict[str, Any]]:
    recommendation = recommended_grain(data.purchases)
    chosen: Grain = grain or recommendation["grain"]
    base = period or last_complete_months(today, 12)
    return snap_to_grain(base, chosen, data.settings.week_start), chosen, recommendation


def _partial_warning(period: Period, today: date) -> list[dict[str, str]]:
    if not period.is_partial(today):
        return []
    return [
        {
            "code": "PARTIAL_PERIOD",
            "message": "The last period has not ended yet: its values are to date.",
        }
    ]


def retention_query(
    data: OrgData,
    period: Period | None = None,
    grain: Grain | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    today = today_in(data.timezone, now)
    snapped, chosen, recommendation = _series_period(data, period, grain, today)
    buckets = whole_buckets(snapped, chosen, data.settings.week_start)
    series = retention_series(data.purchases, buckets, today)
    warnings = _partial_warning(snapped, today)
    if any(row["lowSample"] and row["base"] > 0 for row in series):
        warnings.append(LOW_SAMPLE_WARNING)
    if chosen != recommendation["grain"]:
        warnings.append(
            {
                "code": "GRAIN_MISMATCH",
                "message": f"Customers typically buy every {recommendation['medianGapDays']:.0f} "
                f"days: {recommendation['grain']}ly retention reads more reliably.",
            }
        )
    as_of = min(snapped.last_day, today)
    return {
        "meta": _meta(data, "retention_rate", snapped, chosen, as_of, today, now, warnings),
        "data": {"series": series, "recommendedGrain": recommendation},
    }


def churn_query(
    data: OrgData,
    config: SegmentConfig,
    period: Period | None = None,
    grain: Grain | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    today = today_in(data.timezone, now)
    snapped, chosen, recommendation = _series_period(data, period, grain, today)
    buckets = whole_buckets(snapped, chosen, data.settings.week_start)
    churn_days = data.settings.churn_days
    series = churn_series(data.purchases, buckets, churn_days, today)
    as_of = max(min(snapped.last_day, today), snapped.start)
    by_segment = churn_by_segment(
        data.purchases,
        data.customers,
        snapped,
        churn_days,
        as_of,
        data.settings.recency_cut_points,
        config,
    )
    total_churned = len(churned_customers(data.purchases, snapped, churn_days, as_of))
    warnings = _partial_warning(snapped, today)
    if any(row["lowSample"] and row["base"] > 0 for row in series):
        warnings.append(LOW_SAMPLE_WARNING)
    return {
        "meta": _meta(data, "churn_rate", snapped, chosen, as_of, today, now, warnings),
        "data": {
            "series": series,
            "bySegment": by_segment,
            "segmentAsOf": (snapped.start - timedelta(days=1)).isoformat(),
            "totals": {
                "churned": total_churned,
                "reactivated": sum(row["reactivated"] for row in series),
            },
            "churnDays": churn_days,
            "recommendedGrain": recommendation,
        },
    }


def churned_customers_query(
    data: OrgData, period: Period | None = None, now: datetime | None = None
) -> dict[str, Any]:
    today = today_in(data.timezone, now)
    chosen = period or last_complete_months(today, 1)
    as_of = max(min(chosen.last_day, today), chosen.start)
    rows = churned_customers(data.purchases, chosen, data.settings.churn_days, as_of)
    return {
        "meta": _meta(
            data, "churn_rate", chosen, "month", as_of, today, now, _partial_warning(chosen, today)
        ),
        "data": [
            {
                "customerId": customer,
                "lastPurchase": last,
                "churnDate": churned,
                "orders": orders,
                "netCents": net,
            }
            for customer, last, churned, orders, net in zip(
                rows["customer_id"].astype(str).tolist(),
                pd.to_datetime(rows["last_purchase"]).dt.strftime("%Y-%m-%d").tolist(),
                pd.to_datetime(rows["churn_date"]).dt.strftime("%Y-%m-%d").tolist(),
                rows["orders"].astype("int64").tolist(),
                rows["net"].astype("int64").tolist(),
                strict=True,
            )
        ],
    }


def cohorts_query(
    data: OrgData,
    period: Period | None = None,
    max_periods: int = 12,
    now: datetime | None = None,
) -> dict[str, Any]:
    today = today_in(data.timezone, now)
    chosen = period or last_complete_months(today, 12)
    months = cohort_months(chosen.start, chosen.end)
    matrix = cohort_matrix(data.purchases, months, max_periods, today)
    warnings = []
    if any(c["lowSample"] for c in matrix["cohorts"]):
        warnings.append(
            {
                "code": "LOW_SAMPLE",
                "message": "Cohorts with fewer than 30 customers are marked: their rates swing "
                "widely.",
            }
        )
    as_of = min(chosen.last_day, today)
    return {
        "meta": _meta(data, "cohort_retention", chosen, "month", as_of, today, now, warnings),
        "data": matrix,
    }

"""Customer value queries: frequency, CLV, journey and engagement, in the API envelope."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from insights.data.loader import OrgData
from insights.metrics.behavior import cohort_months
from insights.metrics.behavior_queries import LOW_SAMPLE_WARNING, _meta, last_complete_months
from insights.metrics.engagement import (
    engaged_rate,
    engagement_scores,
    score_distribution,
    score_purchase_correlation,
    volume,
)
from insights.metrics.value import (
    acquired_in,
    before_first_purchase,
    clv_by_cohort,
    clv_by_segment,
    clv_distribution,
    clv_summary,
    frequency,
    journey,
    lifetime_totals,
    occasions,
)
from insights.periods import Period, today_in

CENSORING_WARNING = {
    "code": "CENSORED",
    "message": "Recently acquired customers may still make their next purchase: time-to-purchase "
    "figures use a Kaplan–Meier estimate that counts them as still waiting, not as never.",
}


def _window(data: OrgData, period: Period | None, now: datetime | None) -> tuple[Period, date]:
    today = today_in(data.timezone, now)
    return period or last_complete_months(today, 12), today


def frequency_query(
    data: OrgData, period: Period | None = None, now: datetime | None = None
) -> dict[str, Any]:
    """Customers whose first purchase falls in the period, followed up to today."""
    window, today = _window(data, period, now)
    occ = acquired_in(occasions(data.purchases, today), window.start, window.end)
    result = frequency(occ, cohort_months(window.start, window.end), today)
    warnings = [CENSORING_WARNING]
    if result["customers"] and result["customers"] < 30:
        warnings.append(LOW_SAMPLE_WARNING)
    return {
        "meta": _meta(data, "repeat_purchase_rate", window, "month", today, today, now, warnings),
        "data": result,
    }


def clv_query(
    data: OrgData,
    segments: dict[str, str | None],
    period: Period | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Historical CLV to date of every buyer, by acquisition cohort in the period, and by the
    latest snapshot's segment. Measured only: no prediction (ANA-07)."""
    window, today = _window(data, period, now)
    occ = occasions(data.purchases, today)
    totals = lifetime_totals(occ)
    cohorts = clv_by_cohort(
        acquired_in(occ, window.start, window.end),
        cohort_months(window.start, window.end),
        today,
    )
    warnings = []
    if any(c["lowSample"] and c["size"] > 0 for c in cohorts):
        warnings.append(
            {
                "code": "LOW_SAMPLE",
                "message": "Cohorts with fewer than 30 customers are marked: their averages "
                "swing widely.",
            }
        )
    return {
        "meta": _meta(data, "historical_clv", window, "month", today, today, now, warnings),
        "data": {
            "summary": clv_summary(totals),
            "distribution": clv_distribution(totals),
            "byCohort": cohorts,
            "bySegment": clv_by_segment(totals, segments),
        },
    }


def journey_query(
    data: OrgData, period: Period | None = None, now: datetime | None = None
) -> dict[str, Any]:
    window, today = _window(data, period, now)
    occ = occasions(data.purchases, today)
    result = journey(
        occ, data.customers, window.start, window.end, today, data.settings.active_window_days
    )
    result["beforeFirstPurchase"] = before_first_purchase(
        occ, data.interactions, window.start, window.end
    )
    warnings = [CENSORING_WARNING]
    if 0 < result["stages"][0]["customers"] < 30:
        warnings.append(LOW_SAMPLE_WARNING)
    return {
        "meta": _meta(data, "journey_funnel", window, "month", today, today, now, warnings),
        "data": result,
    }


def engagement_query(
    data: OrgData, period: Period | None = None, now: datetime | None = None
) -> dict[str, Any]:
    window, today = _window(data, period, now)
    as_of = max(min(window.last_day, today), window.start)
    churn_days = data.settings.churn_days
    scores = engagement_scores(data.interactions, as_of, data.engagement)
    warnings: list[dict[str, str]] = []
    if data.interactions.empty:
        warnings.append(
            {
                "code": "NO_INTERACTIONS",
                "message": "No interactions recorded yet. Add them on a customer's profile, "
                "through the API or with a CSV import.",
            }
        )
    rate = engaged_rate(data.purchases, data.interactions, as_of, churn_days)
    if rate["lowSample"] and rate["alive"] > 0:
        warnings.append(LOW_SAMPLE_WARNING)
    return {
        "meta": _meta(data, "engagement_score", window, "month", as_of, today, now, warnings),
        "data": {
            "volume": volume(data.interactions, window),
            "engagedRate": rate,
            "scores": {
                "scored": len(scores),
                "distribution": score_distribution(scores),
                "median": float(scores["score"].median()) if len(scores) else None,
            },
            "correlation": score_purchase_correlation(
                data.purchases, data.interactions, as_of, churn_days, data.engagement
            ),
            "config": data.engagement.to_dict(),
        },
    }

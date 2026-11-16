"""The Business Overview query: KPIs for a period, a comparison period, and trend series."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, Literal

from insights.data.loader import OrgData
from insights.definitions import BY_KEY, DEFINITION_VERSIONS
from insights.metrics.core import Ratio, period_kpis, trend
from insights.periods import Grain, Period, auto_grain, buckets, today_in

Compare = Literal["previous_period", "previous_year", "none"]

KPI_ORDER = (
    "total_customers",
    "active_customers",
    "new_customers",
    "returning_customers",
    "retention_rate",
    "churn_rate",
    "aov",
    "historical_clv",
    "revenue_net",
    "orders",
    "buyers",
    "purchase_frequency",
)


def _value(raw: Any) -> float | int | None:
    if isinstance(raw, Ratio):
        return raw.value
    return raw  # type: ignore[no-any-return]


def _change(current: float | int | None, previous: float | int | None, unit: str) -> float | None:
    if current is None or previous is None:
        return None
    if unit == "ratio":
        return current - previous  # percentage points (as a fraction)
    if previous == 0:
        return None
    return (current - previous) / previous


def overview(
    data: OrgData,
    period: Period,
    compare: Compare = "previous_period",
    grain: Grain | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    today = today_in(data.timezone, now)
    as_of = min(period.last_day, today)
    current = period_kpis(data.purchases, data.customers, period, data.settings, as_of)

    comparison: Period | None = None
    previous: dict[str, Any] | None = None
    if compare != "none":
        comparison = period.previous() if compare == "previous_period" else period.previous_year()
        previous = period_kpis(
            data.purchases, data.customers, comparison, data.settings, comparison.last_day
        )

    warnings: list[dict[str, str]] = []
    if period.is_partial(today):
        warnings.append(
            {
                "code": "PARTIAL_PERIOD",
                "message": "The period has not ended yet: values are to date and the comparison "
                "covers a full period.",
            }
        )

    kpis = []
    for key in KPI_ORDER:
        definition = BY_KEY[key]
        raw = current[key]
        value = _value(raw)
        prev = _value(previous[key]) if previous else None
        kpi: dict[str, Any] = {
            "key": key,
            "value": value,
            "previous": prev,
            "change": _change(value, prev, definition.unit),
            "changeType": "points" if definition.unit == "ratio" else "relative",
            "unit": definition.unit,
            "kind": definition.kind,
        }
        if isinstance(raw, Ratio):
            kpi["numerator"], kpi["denominator"] = raw.numerator, raw.denominator
            if raw.low_sample:
                kpi["warning"] = "LOW_SAMPLE"
        kpis.append(kpi)
    if any(k.get("warning") == "LOW_SAMPLE" for k in kpis):
        warnings.append(
            {
                "code": "LOW_SAMPLE",
                "message": "Some rates are based on fewer than 30 customers and can swing widely.",
            }
        )

    trend_grain = grain or auto_grain(period)
    series_periods = buckets(period, trend_grain, data.settings.week_start)
    series = trend(data.purchases, series_periods)
    for row, bucket in zip(series, series_periods, strict=True):
        row["partial"] = bucket.is_partial(today)

    return {
        "meta": {
            "metric": "overview",
            "definitionVersions": DEFINITION_VERSIONS,
            "kind": "measured",
            "period": {**period.to_dict(), "grain": trend_grain},
            "comparePeriod": comparison.to_dict() if comparison else None,
            "asOf": as_of.isoformat(),
            "today": today.isoformat(),
            "timezone": data.timezone,
            "currency": data.currency,
            "settings": data.settings.to_dict(),
            "computedAt": (now or datetime.now(UTC)).isoformat(),
            "dataVersion": data.data_version,
            "warnings": warnings,
        },
        "data": {
            "kpis": kpis,
            "trend": series,
            "guestRevenueShare": current["guest_revenue_share"],
            "historicalClvMedian": current["historical_clv_median"],
        },
    }


def default_period(timezone: str, now: datetime | None = None) -> Period:
    """The last complete calendar month."""
    today = today_in(timezone, now)
    first = today.replace(day=1)
    previous_first = date(first.year - (first.month == 1), (first.month - 2) % 12 + 1, 1)
    return Period(previous_first, first)

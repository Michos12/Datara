"""Core customer and business metrics (docs/05-analytics-methodology.md §4–5).

Pure functions over the loader's frames: no I/O, so every formula is unit-tested against
hand-computed fixtures. Inputs:

* purchases: one row per (customer_id | None, local day) with orders and net (minor units).
  customer_id is None for guest orders and for orders of deleted customers.
* customers: customer_id and `since` (the date they became a customer).

Dates are pandas Timestamps at midnight representing local business dates.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from threading import Lock
from typing import Any, cast

import numpy as np
import pandas as pd

from insights.periods import Period
from insights.settings import AnalyticsSettings

MIN_SAMPLE = 30
"""Rates over fewer customers than this carry a LOW_SAMPLE warning (ANA-10)."""


def ts(day: date) -> pd.Timestamp:
    return pd.Timestamp(day)


_MEMO: OrderedDict[tuple[str, int], tuple[pd.DataFrame, object]] = OrderedDict()
_MEMO_LOCK = Lock()
_MEMO_SIZE = 16


def _memo[T](kind: str, frame: pd.DataFrame, build: Callable[[], T]) -> T:
    """Per-frame memo for derived data that many periods and queries reuse. Frames are never
    modified after loading; the entry keeps a reference to its frame so the id stays unique."""
    key = (kind, id(frame))
    with _MEMO_LOCK:
        hit = _MEMO.get(key)
        if hit is not None and hit[0] is frame:
            _MEMO.move_to_end(key)
            return cast(T, hit[1])
    value = build()
    with _MEMO_LOCK:
        _MEMO[key] = (frame, value)
        while len(_MEMO) > _MEMO_SIZE:
            _MEMO.popitem(last=False)
    return value


def _identified(purchases: pd.DataFrame) -> pd.DataFrame:
    return _memo("identified", purchases, lambda: purchases[purchases["customer_id"].notna()])


def _in(purchases: pd.DataFrame, period: Period) -> pd.DataFrame:
    days = purchases["day"]
    return purchases[(days >= ts(period.start)) & (days < ts(period.end))]


def buyers(purchases: pd.DataFrame, period: Period) -> set[str]:
    """C(P): distinct identified customers with a countable order in P."""
    return set(_in(_identified(purchases), period)["customer_id"])


def first_purchase(purchases: pd.DataFrame) -> pd.Series:
    """first(c): business date of each customer's first countable order ever."""
    return _memo(
        "first", purchases, lambda: _identified(purchases).groupby("customer_id")["day"].min()
    )


def last_purchase_before(purchases: pd.DataFrame, end: date) -> pd.Series:
    """last(c, d): each customer's last countable order before `end` (exclusive)."""
    p = _identified(purchases)
    return p[p["day"] < ts(end)].groupby("customer_id")["day"].max()


@dataclass(frozen=True, slots=True)
class Ratio:
    numerator: int
    denominator: int

    @property
    def value(self) -> float | None:
        return self.numerator / self.denominator if self.denominator else None

    @property
    def low_sample(self) -> bool:
        return self.denominator < MIN_SAMPLE


def retention(purchases: pd.DataFrame, period: Period) -> Ratio:
    """retention(P) = |C(P₋₁) ∩ C(P)| / |C(P₋₁)| — of last period's buyers, the share who bought
    again this period (§4.1)."""
    base = buyers(purchases, period.previous())
    retained = base & buyers(purchases, period)
    return Ratio(len(retained), len(base))


@dataclass(frozen=True)
class PurchaseDays:
    """Each customer's distinct purchase days in order, with the previous and next purchase
    day. Building it is the expensive part of churn, reactivation and gap metrics (a sort and
    grouped shifts over the whole history: seconds at 1M orders), so it is built once per
    purchases frame and reused by every period and query on that frame."""

    days: pd.DataFrame
    """customer_id, day, prev_day and next_day (NaT at either end)"""

    @staticmethod
    def build(purchases: pd.DataFrame) -> PurchaseDays:
        p = _identified(purchases)[["customer_id", "day"]].drop_duplicates()
        p = p.sort_values(["customer_id", "day"]).reset_index(drop=True)
        grouped = p.groupby("customer_id")["day"]
        p["prev_day"] = grouped.shift(1)
        p["next_day"] = grouped.shift(-1)
        return PurchaseDays(p)

    @staticmethod
    def of(purchases: pd.DataFrame) -> PurchaseDays:
        """Memoised `build` for this exact frame object (see `_memo`)."""
        return _memo("purchase_days", purchases, lambda: PurchaseDays.build(purchases))


def churn(
    purchases: pd.DataFrame,
    period: Period,
    churn_days: int,
    as_of: date,
    prepared: PurchaseDays | None = None,
) -> Ratio:
    """Inactivity-based churn (§4.2).

    A customer churns on `last purchase + churn_days` if they did not buy again before then.
    base = customers alive at the start of P (last purchase before P within churn_days);
    churned = base customers whose churn date falls in P and has already happened by `as_of`.
    Purchases after `as_of` are ignored: a later purchase does not undo a churn already seen.
    """
    p = (prepared or PurchaseDays.of(purchases)).days
    p = p[p["day"] <= ts(as_of)]
    start, end = ts(period.start), ts(period.end)
    threshold = pd.Timedelta(days=churn_days)

    last_before = p[p["day"] < start].groupby("customer_id")["day"].max()
    alive = set(last_before[last_before >= start - threshold].index)

    # The next purchase only counts if it happened by as_of (as if later data did not exist).
    nxt = p["next_day"].where(p["next_day"] <= ts(as_of))
    churn_date = p["day"] + threshold
    lapsed = nxt.isna() | (nxt > churn_date)
    events = p[lapsed & (churn_date >= start) & (churn_date < end) & (churn_date <= ts(as_of))]
    churned = alive & set(events["customer_id"])
    return Ratio(len(churned), len(alive))


def active_customers(purchases: pd.DataFrame, as_of: date, window_days: int) -> int:
    """Customers whose last purchase on or before `as_of` was within the active window."""
    last = last_purchase_before(purchases, as_of + timedelta(days=1))
    return int((last >= ts(as_of) - pd.Timedelta(days=window_days)).sum())


def total_customers(customers: pd.DataFrame, end: date) -> int:
    """Non-deleted customers who had become customers before `end`."""
    # to_datetime keeps the comparison typed even when there are no customers (empty column).
    return int((pd.to_datetime(customers["since"]) < ts(end)).sum())


def historical_clv(purchases: pd.DataFrame, as_of: date) -> dict[str, float | int | None]:
    """Mean and median net revenue per customer up to `as_of`, over customers who bought (§5.1)."""
    p = _identified(purchases)
    totals = p[p["day"] <= ts(as_of)].groupby("customer_id")["net"].sum()
    if totals.empty:
        return {"mean": None, "median": None, "customers": 0}
    return {
        "mean": float(totals.mean()),
        "median": float(totals.median()),
        "customers": int(totals.size),
    }


def period_kpis(
    purchases: pd.DataFrame,
    customers: pd.DataFrame,
    period: Period,
    settings: AnalyticsSettings,
    as_of: date,
    prepared: PurchaseDays | None = None,
    first: pd.Series | None = None,
) -> dict[str, Any]:
    """All Business Overview KPIs for one period. Money in minor units; rates 0..1.
    `prepared` and `first` can be passed in when computing many periods of the same data."""
    in_p = _in(purchases, period)
    revenue = int(in_p["net"].sum())
    orders = int(in_p["orders"].sum())
    identified = in_p[in_p["customer_id"].notna()]
    c_p = set(identified["customer_id"])
    first = first_purchase(purchases) if first is None else first
    new = set(first[(first >= ts(period.start)) & (first < ts(period.end))].index)
    ret = retention(purchases, period)
    ch = churn(purchases, period, settings.churn_days, as_of, prepared)
    clv = historical_clv(purchases, as_of)
    return {
        "total_customers": total_customers(customers, period.end),
        "active_customers": active_customers(purchases, as_of, settings.active_window_days),
        "buyers": len(c_p),
        "new_customers": len(new),
        "returning_customers": len(c_p - new),
        "revenue_net": revenue,
        "orders": orders,
        "aov": revenue / orders if orders else None,
        "purchase_frequency": int(identified["orders"].sum()) / len(c_p) if c_p else None,
        "retention_rate": ret,
        "churn_rate": ch,
        "historical_clv": clv["mean"],
        "historical_clv_median": clv["median"],
        "guest_revenue_share": (
            int(in_p.loc[in_p["customer_id"].isna(), "net"].sum()) / revenue if revenue else None
        ),
    }


def trend(purchases: pd.DataFrame, periods: list[Period]) -> list[dict[str, Any]]:
    """Revenue and acquisition series over consecutive buckets."""
    first = first_purchase(purchases)
    rows: list[dict[str, Any]] = []
    for bucket in periods:
        in_b = _in(purchases, bucket)
        revenue = int(in_b["net"].sum())
        orders = int(in_b["orders"].sum())
        c_b = set(in_b.loc[in_b["customer_id"].notna(), "customer_id"])
        new = int(((first >= ts(bucket.start)) & (first < ts(bucket.end))).sum())
        rows.append(
            {
                "period": bucket.start.isoformat(),
                "end": bucket.end.isoformat(),
                "revenueNet": revenue,
                "orders": orders,
                "aov": round(revenue / orders) if orders else None,
                "buyers": len(c_b),
                "newCustomers": new,
                "returningCustomers": len(c_b) - new,
            }
        )
    return rows


LIFECYCLE = ("PROSPECT", "ACTIVE", "AT_RISK", "CHURNED")


def customer_metrics(
    purchases: pd.DataFrame,
    customers: pd.DataFrame,
    as_of: date,
    settings: AnalyticsSettings,
) -> pd.DataFrame:
    """Per-customer snapshot as of `as_of` (§4.3, §5.1, §8.1). One row per non-deleted customer."""
    p = _identified(purchases)
    p = p[p["day"] <= ts(as_of)]
    grouped = p.groupby("customer_id")
    agg = pd.DataFrame(
        {
            "order_count": grouped["orders"].sum(),
            "total_net": grouped["net"].sum(),
            "first_day": grouped["day"].min(),
            "last_day": grouped["day"].max(),
            "purchase_days": grouped["day"].nunique(),
        }
    )
    gaps = p.sort_values(["customer_id", "day"]).groupby("customer_id")["day"].diff().dt.days
    agg["median_gap"] = gaps.groupby(p.sort_values(["customer_id", "day"])["customer_id"]).median()

    out = customers[["customer_id"]].merge(agg, left_on="customer_id", right_index=True, how="left")
    out["order_count"] = out["order_count"].fillna(0).astype("int64")
    out["total_net"] = out["total_net"].fillna(0).astype("int64")
    out["aov"] = np.where(
        out["order_count"] > 0,
        np.round(out["total_net"] / out["order_count"].clip(lower=1)),
        np.nan,
    )
    as_of_ts = ts(as_of)
    out["recency_days"] = (as_of_ts - out["last_day"]).dt.days
    out["tenure_days"] = (as_of_ts - out["first_day"]).dt.days
    tenure = out["tenure_days"].clip(lower=1)
    out["frequency_per_month"] = np.where(
        out["order_count"] > 0, out["purchase_days"] / tenure * 30, np.nan
    )
    conditions = [
        out["order_count"] == 0,
        out["recency_days"] <= settings.active_window_days,
        out["recency_days"] <= settings.churn_days,
    ]
    out["lifecycle_status"] = np.select(conditions, list(LIFECYCLE[:3]), default="CHURNED")
    out["historical_clv"] = out["total_net"]
    return out.drop(columns=["purchase_days"]).reset_index(drop=True)


def lifecycle_counts(metrics: pd.DataFrame) -> dict[str, int]:
    counts = metrics["lifecycle_status"].value_counts()
    return {status: int(counts.get(status, 0)) for status in LIFECYCLE}

"""Purchase frequency, time to second purchase, historical CLV and the lifecycle journey
(docs/05-analytics-methodology.md §5, §8.1, §8.2).

Pure functions over the loader's frames. The purchases frame already holds one row per
(customer, local day), so a row is a *purchase occasion*: several orders by the same customer on
the same business day count once. Every count on the Frequency page uses occasions, so the order
histogram, the repeat purchase rate and the time to second purchase always agree.
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Any

import pandas as pd

from insights.metrics.behavior import wilson
from insights.metrics.core import MIN_SAMPLE, _identified, ts

ORDER_BUCKETS: tuple[tuple[str, int, int | None], ...] = (
    ("1", 1, 1),
    ("2", 2, 2),
    ("3", 3, 3),
    ("4", 4, 4),
    ("5", 5, 5),
    ("6–10", 6, 10),
    ("11+", 11, None),
)
GAP_BUCKETS: tuple[tuple[str, int, int | None], ...] = (
    ("1–7", 1, 7),
    ("8–14", 8, 14),
    ("15–30", 15, 30),
    ("31–60", 31, 60),
    ("61–90", 61, 90),
    ("91–180", 91, 180),
    ("181–365", 181, 365),
    ("366+", 366, None),
)
SECOND_PURCHASE_HORIZONS = (30, 60, 90, 180, 365)
CLV_HORIZONS = (90, 180, 365)
CURVE_POINTS = 120


# ───────────── Kaplan–Meier ─────────────


def kaplan_meier(durations: pd.Series, observed: pd.Series) -> pd.DataFrame:
    """Product-limit estimate of S(t) = P(no event by t) at every distinct event time.

    `durations` are days from the start event (≥ 0); `observed` is True where the event happened
    and False where the customer is right-censored (still waiting). Ties: events at t are
    counted before censorings at t, as in lifelines. Returns columns time, at_risk, events,
    censored and survival, ordered by time.
    """
    frame = pd.DataFrame(
        {"t": durations.astype("int64").to_numpy(), "e": observed.astype(bool).to_numpy()}
    )
    if frame.empty:
        return pd.DataFrame(columns=["time", "at_risk", "events", "censored", "survival"])
    grouped = frame.groupby("t")["e"].agg(events="sum", total="count").sort_index()
    grouped["censored"] = grouped["total"] - grouped["events"]
    at_risk = len(frame) - grouped["total"].cumsum().shift(fill_value=0)
    grouped["at_risk"] = at_risk
    factor = 1 - grouped["events"] / grouped["at_risk"]
    grouped["survival"] = factor.cumprod()
    out = grouped.reset_index().rename(columns={"t": "time"})
    return out[["time", "at_risk", "events", "censored", "survival"]].astype(
        {"time": "int64", "at_risk": "int64", "events": "int64", "censored": "int64"}
    )


def survival_at(curve: pd.DataFrame, t: float) -> float:
    """S(t): the estimate at the last time ≤ t (1.0 before the first time)."""
    before = curve[curve["time"] <= t]
    return 1.0 if before.empty else float(before["survival"].iloc[-1])


def km_quantile(curve: pd.DataFrame, share: float) -> int | None:
    """First time by which at least `share` of customers had the event (1 − S(t) ≥ share).
    None when the estimate never gets there (too many still waiting)."""
    reached = curve[(1 - curve["survival"]) >= share - 1e-12]
    return None if reached.empty else int(reached["time"].iloc[0])


def _downsample(curve: pd.DataFrame, points: int) -> list[dict[str, Any]]:
    rows = [{"days": 0, "share": 0.0}]
    if curve.empty:
        return rows
    step = max(1, math.ceil(len(curve) / points))
    sampled = curve.iloc[::step]
    if sampled.index[-1] != curve.index[-1]:
        sampled = pd.concat([sampled, curve.iloc[[-1]]])
    rows += [
        {"days": int(t), "share": round(1 - float(s), 6)}
        for t, s in zip(sampled["time"], sampled["survival"], strict=True)
    ]
    return rows


# ───────────── occasions ─────────────


def occasions(purchases: pd.DataFrame, as_of: date) -> pd.DataFrame:
    """Identified purchase occasions up to `as_of`, with each customer's occasion number (1 = first
    purchase) and the gap in days since their previous occasion."""
    p = _identified(purchases)
    p = p[p["day"] <= ts(as_of)][["customer_id", "day", "orders", "net"]]
    p = p.groupby(["customer_id", "day"], as_index=False).agg(orders=("orders", "sum"),
                                                               net=("net", "sum"))  # fmt: skip
    p = p.sort_values(["customer_id", "day"]).reset_index(drop=True)
    p["n"] = p.groupby("customer_id").cumcount() + 1
    p["gap"] = p.groupby("customer_id")["day"].diff().dt.days
    return p


def acquired_in(occ: pd.DataFrame, start: date, end: date) -> pd.DataFrame:
    """Occasions of the customers whose first purchase falls in [start, end)."""
    first = occ[occ["n"] == 1]
    ids = first.loc[(first["day"] >= ts(start)) & (first["day"] < ts(end)), "customer_id"]
    return occ[occ["customer_id"].isin(set(ids))]


def _bucket_counts(
    values: pd.Series, buckets: tuple[tuple[str, int, int | None], ...]
) -> list[dict[str, Any]]:
    out = []
    for label, low, high in buckets:
        mask = values >= low if high is None else (values >= low) & (values <= high)
        out.append({"bucket": label, "min": low, "max": high, "count": int(mask.sum())})
    return out


def _quantiles(values: pd.Series) -> dict[str, float | None]:
    if values.empty:
        return {"p25": None, "median": None, "p75": None, "mean": None}
    return {
        "p25": float(values.quantile(0.25)),
        "median": float(values.median()),
        "p75": float(values.quantile(0.75)),
        "mean": float(values.mean()),
    }


def _rate(numerator: int, denominator: int) -> dict[str, Any]:
    interval = wilson(numerator, denominator)
    return {
        "rate": numerator / denominator if denominator else None,
        "low": interval[0] if interval else None,
        "high": interval[1] if interval else None,
        "lowSample": denominator < MIN_SAMPLE,
    }


# ───────────── frequency ─────────────


def time_to_second(occ: pd.DataFrame, today: date) -> dict[str, Any]:
    """Kaplan–Meier share of customers who made a second purchase within t days of the first.

    Customers without a second purchase are censored at today − first purchase: they may still
    buy. A plain average over customers who did return would be biased low (§8.1).
    """
    first = occ[occ["n"] == 1].set_index("customer_id")["day"]
    second = occ[occ["n"] == 2].set_index("customer_id")["day"].reindex(first.index)
    observed = second.notna()
    end = second.where(observed, ts(today))
    durations = (end - first).dt.days.clip(lower=0)
    curve = kaplan_meier(durations, observed)
    repeat_gaps = durations[observed]
    return {
        "customers": len(first),
        "repeated": int(observed.sum()),
        "censored": int((~observed).sum()),
        "within": [
            {
                "days": h,
                "share": 1 - survival_at(curve, h),
                # Customers acquired at least h days ago: the horizon is fully observed for them.
                "observedCustomers": int(((ts(today) - first).dt.days >= h).sum()),
            }
            for h in SECOND_PURCHASE_HORIZONS
        ],
        "quantiles": {
            "p25": km_quantile(curve, 0.25),
            "median": km_quantile(curve, 0.5),
            "p75": km_quantile(curve, 0.75),
        },
        "repeaters": {
            "p25": float(repeat_gaps.quantile(0.25)) if len(repeat_gaps) else None,
            "median": float(repeat_gaps.median()) if len(repeat_gaps) else None,
            "p75": float(repeat_gaps.quantile(0.75)) if len(repeat_gaps) else None,
        },
        "curve": _downsample(curve, CURVE_POINTS),
    }


def repeat_by_cohort(occ: pd.DataFrame, months: list[date], today: date) -> list[dict[str, Any]]:
    """Per acquisition month: repeat rate to date, and the comparable 90-day repeat rate once
    every cohort customer has had 90 days (null before that)."""
    first = occ[occ["n"] == 1].set_index("customer_id")["day"]
    second = occ[occ["n"] == 2].set_index("customer_id")["day"].reindex(first.index)
    rows = []
    for month in months:
        nxt = (pd.Timestamp(month) + pd.offsets.MonthBegin(1)).date()
        in_cohort = (first >= ts(month)) & (first < ts(nxt))
        size = int(in_cohort.sum())
        repeated = int(second[in_cohort].notna().sum())
        complete_90 = nxt + timedelta(days=90) <= today + timedelta(days=1)
        within_90 = int(((second[in_cohort] - first[in_cohort]).dt.days <= 90).sum())
        rows.append(
            {
                "cohort": month.strftime("%Y-%m"),
                "size": size,
                "repeated": repeated,
                **_rate(repeated, size),
                "within90": (within_90 / size if size else None) if complete_90 else None,
            }
        )
    return rows


def frequency(occ: pd.DataFrame, months: list[date], today: date) -> dict[str, Any]:
    """Frequency facts for the customers in `occ` (already limited to an acquisition window)."""
    counts = occ.groupby("customer_id")["n"].max()
    buyers = len(counts)
    repeat = int((counts >= 2).sum())
    gaps = occ["gap"].dropna().astype("int64")
    return {
        "customers": buyers,
        "orderCounts": _bucket_counts(counts, ORDER_BUCKETS),
        "repeat": {"customers": buyers, "repeated": repeat, **_rate(repeat, buyers)},
        "averagePurchases": float(counts.mean()) if buyers else None,
        "gaps": {
            "count": len(gaps),
            **_quantiles(gaps),
            "histogram": _bucket_counts(gaps, GAP_BUCKETS),
        },
        "timeToSecond": time_to_second(occ, today),
        "byCohort": repeat_by_cohort(occ, months, today),
    }


# ───────────── historical CLV ─────────────


def _nice_step(value: float) -> int:
    """1, 2 or 5 × 10^k at or above `value` (at least 1)."""
    if value <= 1:
        return 1
    exponent = math.floor(math.log10(value))
    for factor in (1, 2, 5, 10):
        step = factor * 10**exponent
        if step >= value:
            return int(step)
    return int(10 ** (exponent + 1))


def clv_distribution(totals: pd.Series, bins: int = 10) -> list[dict[str, Any]]:
    """Equal-width bins up to about the 95th percentile, plus an open-ended top bin."""
    if totals.empty:
        return []
    step = _nice_step(max(float(totals.quantile(0.95)), 1) / bins)
    edges = [i * step for i in range(bins + 1)]
    rows = []
    for i in range(bins):
        low = edges[i]
        mask = (totals >= low) & (totals < edges[i + 1]) if i < bins - 1 else totals >= low
        if i == 0:
            mask = mask | (totals < 0)
        rows.append(
            {"min": low, "max": None if i == bins - 1 else edges[i + 1], "count": int(mask.sum())}
        )
    return rows


def clv_summary(totals: pd.Series) -> dict[str, Any]:
    """Historical CLV of customers with at least one purchase (§5.1). Money in minor units."""
    if totals.empty:
        return {"customers": 0, "mean": None, "median": None, "p25": None, "p75": None,
                "p90": None, "total": 0, "top10Share": None}  # fmt: skip
    ordered = totals.sort_values(ascending=False)
    top = ordered.iloc[: max(1, math.ceil(len(ordered) * 0.1))]
    total = int(totals.sum())
    return {
        "customers": len(totals),
        "mean": float(totals.mean()),
        "median": float(totals.median()),
        "p25": float(totals.quantile(0.25)),
        "p75": float(totals.quantile(0.75)),
        "p90": float(totals.quantile(0.9)),
        "total": total,
        "top10Share": float(top.sum()) / total if total > 0 else None,
    }


def clv_by_cohort(occ: pd.DataFrame, months: list[date], today: date) -> list[dict[str, Any]]:
    """Mean net revenue per cohort customer within 90, 180 and 365 days of the first purchase.
    A horizon is shown only once every customer in the cohort has had that long (else null)."""
    first = occ[occ["n"] == 1].set_index("customer_id")["day"]
    age = (occ["day"] - occ["customer_id"].map(first)).dt.days
    rows = []
    for month in months:
        nxt = (pd.Timestamp(month) + pd.offsets.MonthBegin(1)).date()
        members = first[(first >= ts(month)) & (first < ts(nxt))].index
        size = len(members)
        mine = occ["customer_id"].isin(set(members))
        horizons: dict[str, float | None] = {}
        for h in CLV_HORIZONS:
            complete = nxt + timedelta(days=h) <= today + timedelta(days=1)
            net = int(occ.loc[mine & (age < h), "net"].sum())
            horizons[str(h)] = (net / size if size else None) if complete else None
        rows.append(
            {
                "cohort": month.strftime("%Y-%m"),
                "size": size,
                "lowSample": size < MIN_SAMPLE,
                "toDate": int(occ.loc[mine, "net"].sum()) / size if size else None,
                "withinDays": horizons,
            }
        )
    return rows


def clv_by_segment(totals: pd.Series, segments: dict[str, str | None]) -> list[dict[str, Any]]:
    """Historical CLV by the latest snapshot's segment. `segments` maps customer → segment key
    (None = not scored). Customers missing from the snapshot are left out."""
    if totals.empty or not segments:
        return []
    keyed = pd.Series(segments, dtype="object").reindex(totals.index)
    known = keyed.index[keyed.index.isin(list(segments))]
    frame = pd.DataFrame({"segment": keyed.loc[known], "clv": totals.loc[known]})
    frame["segment"] = frame["segment"].fillna("_none")
    grand = float(frame["clv"].sum())
    rows = []
    for key, group in frame.groupby("segment", sort=False):
        total = float(group["clv"].sum())
        rows.append(
            {
                "segment": None if key == "_none" else str(key),
                "customers": len(group),
                "mean": float(group["clv"].mean()),
                "median": float(group["clv"].median()),
                "total": int(total),
                "revenueShare": total / grand if grand > 0 else None,
                "lowSample": len(group) < MIN_SAMPLE,
            }
        )
    return sorted(rows, key=lambda r: r["mean"], reverse=True)


# ───────────── journey ─────────────

JOURNEY_STAGES = ("registered", "first", "second", "third", "active")


def journey(
    occ: pd.DataFrame,
    customers: pd.DataFrame,
    start: date,
    end: date,
    today: date,
    active_window_days: int,
) -> dict[str, Any]:
    """Lifecycle funnel of the customers who became customers in [start, end) (§8.2).

    Stages: became a customer → 1st purchase → 2nd → 3rd+ purchase occasion, plus the share of
    first-time buyers still active today. Stage timing is a Kaplan–Meier median, censored at
    today for customers who have not reached the next stage yet.
    """
    since = customers.set_index("customer_id")["since"]
    since = since[(since >= ts(start)) & (since < ts(end))]
    population = set(since.index)
    mine = occ[occ["customer_id"].isin(population)]
    day_of = {n: mine[mine["n"] == n].set_index("customer_id")["day"] for n in (1, 2, 3)}
    last = mine.groupby("customer_id")["day"].max()
    counts = {
        "registered": len(population),
        "first": len(day_of[1]),
        "second": len(day_of[2]),
        "third": len(day_of[3]),
        "active": int((last >= ts(today) - pd.Timedelta(days=active_window_days)).sum()),
    }
    previous = {"first": "registered", "second": "first", "third": "second", "active": "first"}
    stages = []
    for key in JOURNEY_STAGES:
        row: dict[str, Any] = {"stage": key, "customers": counts[key]}
        if key in previous:
            base = counts[previous[key]]
            row["conversion"] = _rate(counts[key], base)
        stages.append(row)

    def timing(start_days: pd.Series, next_days: pd.Series) -> dict[str, Any]:
        reached = next_days.reindex(start_days.index)
        observed = reached.notna()
        durations = (reached.where(observed, ts(today)) - start_days).dt.days.clip(lower=0)
        curve = kaplan_meier(durations, observed)
        return {
            "customers": len(start_days),
            "reached": int(observed.sum()),
            "censored": int((~observed).sum()),
            "medianDays": km_quantile(curve, 0.5),
            "observedMedianDays": float(durations[observed].median()) if observed.any() else None,
        }

    return {
        "stages": stages,
        "timing": [
            {"from": "registered", "to": "first", **timing(since, day_of[1])},
            {"from": "first", "to": "second", **timing(day_of[1], day_of[2])},
            {"from": "second", "to": "third", **timing(day_of[2], day_of[3])},
        ],
    }


def before_first_purchase(
    occ: pd.DataFrame,
    interactions: pd.DataFrame,
    start: date,
    end: date,
    days: int = 30,
) -> dict[str, Any]:
    """Interaction types seen in the `days` days up to and including the first purchase, for
    customers whose first purchase falls in [start, end). Descriptive only: no attribution."""
    first = occ[occ["n"] == 1].set_index("customer_id")["day"]
    first = first[(first >= ts(start)) & (first < ts(end))]
    if first.empty or interactions.empty:
        return {"firstPurchasers": len(first), "withInteractions": 0, "types": []}
    i = interactions[interactions["customer_id"].isin(set(first.index))].copy()
    i["first"] = i["customer_id"].map(first)
    window = i[(i["day"] <= i["first"]) & (i["day"] > i["first"] - pd.Timedelta(days=days))]
    by_type = window.groupby("type")["customer_id"].nunique().sort_values(ascending=False)
    total = len(first)
    return {
        "firstPurchasers": int(total),
        "withInteractions": int(window["customer_id"].nunique()),
        "types": [
            {"type": str(t).lower(), "customers": int(n), "share": int(n) / total}
            for t, n in by_type.items()
        ],
    }


def lifetime_totals(occ: pd.DataFrame) -> pd.Series:
    """Net revenue to date per customer with at least one purchase occasion."""
    return occ.groupby("customer_id")["net"].sum().astype("int64")

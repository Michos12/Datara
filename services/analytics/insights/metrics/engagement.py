"""Engagement from interactions (docs/05-analytics-methodology.md §8.3).

Types are upper case inside (as stored in Postgres) and lower case in API output and settings.

Interactions arrive as one row per (customer, local day, type, channel) with a count `n`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from insights.metrics.behavior import wilson
from insights.metrics.core import MIN_SAMPLE, _identified, ts
from insights.periods import Period, buckets

INTERACTION_TYPES = (
    "WEBSITE_VISIT",
    "EMAIL_SENT",
    "EMAIL_OPENED",
    "EMAIL_CLICKED",
    "SUPPORT_TICKET",
    "REVIEW",
    "LOYALTY_SIGNUP",
    "CAMPAIGN_RESPONSE",
    "OTHER",
)
DEFAULT_WEIGHTS: dict[str, int] = {
    "WEBSITE_VISIT": 1,
    "EMAIL_SENT": 0,
    "EMAIL_OPENED": 1,
    "EMAIL_CLICKED": 3,
    "SUPPORT_TICKET": 0,
    "REVIEW": 5,
    "LOYALTY_SIGNUP": 5,
    "CAMPAIGN_RESPONSE": 4,
    "OTHER": 1,
}
DEFAULT_CAP = 10
WINDOW_DAYS = 90

EMPTY_INTERACTIONS = pd.DataFrame(
    {
        "customer_id": pd.Series(dtype="object"),
        "day": pd.Series(dtype="datetime64[ns]"),
        "type": pd.Series(dtype="object"),
        "channel": pd.Series(dtype="object"),
        "n": pd.Series(dtype="int64"),
    }
)


@dataclass(frozen=True, slots=True)
class EngagementConfig:
    """Weight per interaction type and the per-type count cap over the 90-day window."""

    weights: tuple[tuple[str, int], ...]
    cap: int = DEFAULT_CAP

    @property
    def weight_map(self) -> dict[str, int]:
        return dict(self.weights)

    def to_dict(self) -> dict[str, Any]:
        return {
            "weights": {t.lower(): w for t, w in self.weights},
            "cap": self.cap,
            "windowDays": WINDOW_DAYS,
        }

    @staticmethod
    def from_settings(raw: Any) -> EngagementConfig:
        """`settings.engagement` of the organization; anything invalid falls back to defaults."""
        weights = dict(DEFAULT_WEIGHTS)
        cap = DEFAULT_CAP
        if isinstance(raw, dict):
            stored = raw.get("weights")
            if isinstance(stored, dict):
                for name, value in stored.items():
                    key = str(name).upper()
                    if key in weights and isinstance(value, int) and 0 <= value <= 10:
                        weights[key] = value
            stored_cap = raw.get("cap")
            if isinstance(stored_cap, int) and 1 <= stored_cap <= 100:
                cap = stored_cap
        return EngagementConfig(tuple((t, weights[t]) for t in INTERACTION_TYPES), cap)


DEFAULT_ENGAGEMENT = EngagementConfig.from_settings(None)


def _window(interactions: pd.DataFrame, as_of: date, days: int = WINDOW_DAYS) -> pd.DataFrame:
    end = ts(as_of)
    return interactions[
        (interactions["day"] <= end) & (interactions["day"] > end - pd.Timedelta(days=days))
    ]


def engagement_scores(
    interactions: pd.DataFrame, as_of: date, config: EngagementConfig = DEFAULT_ENGAGEMENT
) -> pd.DataFrame:
    """raw(c) = Σ_type weight(type) × min(count in the last 90 days, cap); score = percentile
    rank of log(1 + raw) among customers with raw > 0, × 100 (kind: score, relative to the
    tenant). Customers with raw = 0 are not in the result."""
    recent = _window(interactions, as_of)
    if recent.empty:
        return pd.DataFrame(
            {
                "customer_id": pd.Series(dtype="object"),
                "raw": pd.Series(dtype="float64"),
                "score": pd.Series(dtype="int64"),
            }
        )
    counts = recent.groupby(["customer_id", "type"])["n"].sum().clip(upper=config.cap)
    weights = counts.index.get_level_values("type").map(config.weight_map).fillna(0)
    raw = (counts * weights.to_numpy()).groupby(level="customer_id").sum()
    raw = raw[raw > 0].astype("float64")
    if raw.empty:
        return pd.DataFrame(
            {
                "customer_id": pd.Series(dtype="object"),
                "raw": pd.Series(dtype="float64"),
                "score": pd.Series(dtype="int64"),
            }
        )
    pct = np.log1p(raw).rank(method="average", pct=True)
    out = pd.DataFrame({"customer_id": raw.index.astype(str), "raw": raw.to_numpy()})
    # Round half up so equal inputs always give the same integer score.
    out["score"] = np.floor(pct.to_numpy() * 100 + 0.5).astype("int64")
    return out.sort_values("customer_id").reset_index(drop=True)


def _alive(purchases: pd.DataFrame, as_of: date, churn_days: int) -> set[str]:
    p = _identified(purchases)
    last = p[p["day"] <= ts(as_of)].groupby("customer_id")["day"].max()
    return set(last[last >= ts(as_of) - pd.Timedelta(days=churn_days)].index)


def engaged_rate(
    purchases: pd.DataFrame, interactions: pd.DataFrame, as_of: date, churn_days: int
) -> dict[str, Any]:
    """Alive customers (last purchase within the churn threshold) with ≥ 1 interaction in the last
    90 days ÷ alive customers. Interactions of weight 0 count: any contact is engagement here."""
    alive = _alive(purchases, as_of, churn_days)
    engaged = alive & set(_window(interactions, as_of)["customer_id"])
    interval = wilson(len(engaged), len(alive))
    return {
        "alive": len(alive),
        "engaged": len(engaged),
        "rate": len(engaged) / len(alive) if alive else None,
        "low": interval[0] if interval else None,
        "high": interval[1] if interval else None,
        "lowSample": len(alive) < MIN_SAMPLE,
    }


def score_distribution(scores: pd.DataFrame) -> list[dict[str, Any]]:
    out = []
    for low in range(0, 100, 10):
        high = low + 10
        mask = (scores["score"] > low) & (scores["score"] <= high)
        if low == 0:
            mask = scores["score"] <= high
        out.append({"min": low, "max": high, "count": int(mask.sum())})
    return out


def score_purchase_correlation(
    purchases: pd.DataFrame,
    interactions: pd.DataFrame,
    as_of: date,
    churn_days: int,
    config: EngagementConfig,
) -> dict[str, Any]:
    """Spearman ρ between each alive customer's score 90 days ago and their purchase days in the
    90 days since. A sanity check of the score, described as correlation, not causation."""
    then = (ts(as_of) - pd.Timedelta(days=WINDOW_DAYS)).date()
    population = sorted(_alive(purchases, then, churn_days))
    if len(population) < MIN_SAMPLE:
        return {"rho": None, "customers": len(population), "lowSample": True}
    scores = engagement_scores(interactions, then, config).set_index("customer_id")["score"]
    p = _identified(purchases)
    after = p[(p["day"] > ts(then)) & (p["day"] <= ts(as_of))]
    bought = after.groupby("customer_id")["day"].nunique()
    x = scores.reindex(population).fillna(0).astype("float64")
    y = bought.reindex(population).fillna(0).astype("float64")
    if x.nunique() < 2 or y.nunique() < 2:
        return {"rho": None, "customers": len(population), "lowSample": False}
    rho = float(x.rank().corr(y.rank()))
    return {
        "rho": None if math.isnan(rho) else rho,
        "customers": len(population),
        "lowSample": False,
    }


def volume(interactions: pd.DataFrame, period: Period) -> dict[str, Any]:
    """Interaction counts in the period by type, by channel, and per month by type."""
    start, end = ts(period.start), ts(period.end)
    inside = interactions[(interactions["day"] >= start) & (interactions["day"] < end)]
    by_type = inside.groupby("type")["n"].sum()
    channels = inside.assign(channel=inside["channel"].fillna("")).groupby("channel")["n"].sum()
    series = []
    for month in buckets(period, "month"):
        in_month = inside[(inside["day"] >= ts(month.start)) & (inside["day"] < ts(month.end))]
        counts = in_month.groupby("type")["n"].sum()
        series.append(
            {
                "period": month.start.isoformat(),
                "counts": {t.lower(): int(counts.get(t, 0)) for t in INTERACTION_TYPES},
            }
        )
    return {
        "total": int(inside["n"].sum()),
        "customers": int(inside["customer_id"].nunique()),
        "byType": [
            {"type": t.lower(), "count": int(by_type.get(t, 0))}
            for t in INTERACTION_TYPES
            if int(by_type.get(t, 0)) > 0
        ],
        "byChannel": [
            {"channel": str(c) or None, "count": int(n)}
            for c, n in channels.sort_values(ascending=False).items()
        ],
        "series": series,
    }

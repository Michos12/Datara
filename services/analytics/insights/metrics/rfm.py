"""RFM scoring and segmentation (docs/05-analytics-methodology.md §6).

* Recency R: days from the last countable purchase (all time) to the reference date.
* Frequency F: countable orders in the look-back window (as_of - lookback, as_of].
* Monetary M: net revenue in the same window.

Customers who bought before the window but not inside it are not ranked: they get scores
1/1/1 so they cannot distort the quintiles. Customers who never bought are not scored
(segment None, shown as "No purchases").
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

import numpy as np
import pandas as pd

ScoringMethod = Literal["thresholds", "quintile"]


@dataclass(frozen=True, slots=True)
class Rule:
    key: str
    r: tuple[int, int]
    f: tuple[int, int]
    m: tuple[int, int] | None = None


@dataclass(frozen=True, slots=True)
class SegmentConfig:
    lookback_days: int
    recency: ScoringMethod
    frequency: ScoringMethod
    monetary: ScoringMethod
    frequency_thresholds: tuple[int, int, int, int]
    monetary_thresholds: tuple[int, int, int, int] | None
    rules: tuple[Rule, ...]

    @staticmethod
    def from_dict(raw: dict[str, Any]) -> SegmentConfig:
        """Parses the JSON shape of `SegmentConfig` in packages/contracts (validated by the API)."""

        def pair(value: Any) -> tuple[int, int]:
            return int(value[0]), int(value[1])

        def four(value: Any) -> tuple[int, int, int, int]:
            return int(value[0]), int(value[1]), int(value[2]), int(value[3])

        scoring = raw["scoring"]
        return SegmentConfig(
            lookback_days=int(raw["lookbackDays"]),
            recency=scoring["recency"],
            frequency=scoring["frequency"],
            monetary=scoring["monetary"],
            frequency_thresholds=four(raw["frequencyThresholds"]),
            monetary_thresholds=four(raw["monetaryThresholds"])
            if raw.get("monetaryThresholds")
            else None,
            rules=tuple(
                Rule(
                    key=str(rule["key"]),
                    r=pair(rule["r"]),
                    f=pair(rule["f"]),
                    m=pair(rule["m"]) if rule.get("m") else None,
                )
                for rule in raw["rules"]
            ),
        )


def quintile_scores(values: pd.Series) -> pd.Series:
    """1–5 by percentile rank. Ties share a rank (method="average"): with many one-time buyers
    the frequency quintiles are uneven, which is the honest result (§6.2)."""
    if values.empty:
        return values.astype("int64")
    pct = values.rank(method="average", pct=True)
    return pd.Series(np.ceil(pct * 5), index=values.index).clip(1, 5).astype("int64")


def recency_threshold_scores(recency_days: pd.Series, cut_points: tuple[int, ...]) -> pd.Series:
    """5 if within the first cut point, 4 within the second, … 1 beyond the last."""
    c1, c2, c3, c4 = cut_points
    return pd.Series(
        np.select(
            [recency_days <= c1, recency_days <= c2, recency_days <= c3, recency_days <= c4],
            [5, 4, 3, 2],
            default=1,
        ),
        index=recency_days.index,
    ).astype("int64")


def minimum_threshold_scores(values: pd.Series, minimums: tuple[int, ...]) -> pd.Series:
    """1 + the number of thresholds reached: minimums are for scores 2, 3, 4 and 5."""
    score = pd.Series(1, index=values.index, dtype="int64")
    for minimum in minimums:
        score += (values >= minimum).astype("int64")
    return score


def assign_segments(scores: pd.DataFrame, rules: tuple[Rule, ...]) -> pd.Series:
    """First matching rule wins (mirrors assignSegment in packages/contracts)."""
    segment = pd.Series(None, index=scores.index, dtype="object")
    for rule in rules:
        match = (
            segment.isna() & scores["r_score"].between(*rule.r) & scores["f_score"].between(*rule.f)
        )
        if rule.m:
            match &= scores["m_score"].between(*rule.m)
        segment = segment.mask(match, rule.key)
    return segment


def rfm(
    purchases: pd.DataFrame,
    customers: pd.DataFrame,
    as_of: date,
    recency_cut_points: tuple[int, int, int, int],
    config: SegmentConfig,
) -> pd.DataFrame:
    """One row per customer: recency_days, f_value, m_value, r/f/m scores and segment_key."""
    as_of_ts = pd.Timestamp(as_of)
    p = purchases[purchases["customer_id"].notna() & (purchases["day"] <= as_of_ts)]
    last = p.groupby("customer_id")["day"].max()
    window = p[p["day"] > as_of_ts - pd.Timedelta(days=config.lookback_days)]
    grouped = window.groupby("customer_id")

    out = pd.DataFrame({"customer_id": customers["customer_id"]}).set_index("customer_id")
    out["recency_days"] = (as_of_ts - last).dt.days.reindex(out.index)
    out["f_value"] = grouped["orders"].sum().reindex(out.index)
    out["m_value"] = grouped["net"].sum().reindex(out.index)
    bought = out["recency_days"].notna()
    out.loc[bought, ["f_value", "m_value"]] = out.loc[bought, ["f_value", "m_value"]].fillna(0)

    ranked = bought & (out["f_value"] > 0)
    scores = pd.DataFrame(index=out.index[ranked])
    r_days, f, m = (out.loc[ranked, c] for c in ("recency_days", "f_value", "m_value"))
    scores["r_score"] = (
        recency_threshold_scores(r_days, recency_cut_points)
        if config.recency == "thresholds"
        else quintile_scores(-r_days)
    )
    scores["f_score"] = (
        minimum_threshold_scores(f, config.frequency_thresholds)
        if config.frequency == "thresholds"
        else quintile_scores(f)
    )
    scores["m_score"] = (
        minimum_threshold_scores(m, config.monetary_thresholds)
        if config.monetary == "thresholds" and config.monetary_thresholds
        else quintile_scores(m)
    )

    for column in ("r_score", "f_score", "m_score"):
        out[column] = scores[column].reindex(out.index)
        out.loc[bought & ~ranked, column] = 1  # bought before the window: lowest scores

    scored = out.loc[bought, ["r_score", "f_score", "m_score"]].astype("int64")
    out["segment_key"] = assign_segments(scored, config.rules).reindex(out.index)
    return out.reset_index()


def rfm_matrix(segmented: pd.DataFrame) -> list[list[int]]:
    """Customer counts by recency score (rows 1–5) and frequency score (columns 1–5)."""
    scored = segmented.dropna(subset=["r_score", "f_score"])
    matrix = [[0] * 5 for _ in range(5)]
    counts = scored.groupby(["r_score", "f_score"]).size()
    for key, n in zip(counts.index, counts.to_numpy(), strict=True):
        r, f = key
        matrix[int(r) - 1][int(f) - 1] = int(n)
    return matrix


def segment_counts(segmented: pd.DataFrame) -> dict[str, int]:
    return {str(k): int(v) for k, v in segmented["segment_key"].value_counts().items()}

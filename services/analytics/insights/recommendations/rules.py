"""Recommendation rules, version 1 (docs/05-analytics-methodology.md §10).

Each rule is a pure function of a `RuleContext` (one snapshot's per-customer frame plus the
purchases) that returns a `Finding` or None. Revenue at stake is always measured: the affected
customers' net revenue in the 12 months before `as_of`. Nothing here predicts revenue.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import pandas as pd

from insights.metrics.behavior import recommended_grain, whole_buckets
from insights.metrics.core import retention, ts
from insights.periods import Grain, Period, add_months, floor_to_grain
from insights.settings import AnalyticsSettings

TRAILING_DAYS = 365


@dataclass(frozen=True, slots=True)
class RuleSpec:
    key: str
    version: int
    name: str
    trigger: str
    action: str
    thresholds: dict[str, float]

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "version": self.version,
            "name": self.name,
            "trigger": self.trigger,
            "action": self.action,
            "thresholds": self.thresholds,
            "enabled": True,
        }


@dataclass
class RuleContext:
    as_of: date
    customers: pd.DataFrame
    """One row per customer: customer_id, order_count, purchase_days, recency_days, median_gap,
    lifecycle_status, historical_clv, f_score, m_score, segment_key, marketing_consent,
    first_day, value_12m (net revenue in the trailing 12 months)."""
    purchases: pd.DataFrame
    trailing_revenue: int
    """All net revenue in the trailing 12 months, guest orders included."""
    settings: AnalyticsSettings


@dataclass
class Finding:
    rule_key: str
    rule_version: int
    scope: str
    title: str
    opportunity: str
    explanation: str
    suggested_action: str
    metrics: dict[str, Any]
    customers: pd.Series
    """customer_id → trailing-12-month net revenue (minor units), the affected customers."""
    revenue_at_stake: int | None
    priority: str = "LOW"
    priority_score: float = 0.0
    extra_high: bool = field(default=False, repr=False)
    """Rule-specific reason for HIGH priority regardless of impact (retention drop ≥ 5 points)."""

    @property
    def fingerprint(self) -> str:
        return f"{self.rule_key}:{self.scope}"


def _affected(ctx: RuleContext, mask: pd.Series) -> pd.Series:
    rows = ctx.customers[mask]
    return pd.Series(
        rows["value_12m"].astype("int64").to_numpy(), index=rows["customer_id"].astype(str)
    )


def _share(part: float, whole: float) -> float | None:
    return part / whole if whole > 0 else None


def _pct(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.0f}%"


# ───────────── rules ─────────────

CHURN_RISK = RuleSpec(
    "churn_risk_high_value", 1, "High-value customers at risk",
    "F ≥ 4 or M ≥ 4, not churned, ≥ 3 orders, days since last purchase > 1.5 × their own median "
    "gap and > 30. Fires with at least 10 customers.",
    "Personalised win-back offer within 14 days; contact the top 30 by spend directly.",
    {"minScore": 4, "minOrders": 3, "gapMultiple": 1.5, "minRecencyDays": 30, "minCustomers": 10},
)  # fmt: skip


def churn_risk_high_value(ctx: RuleContext) -> Finding | None:
    c = ctx.customers
    t = CHURN_RISK.thresholds
    mask = (
        ((c["f_score"] >= t["minScore"]) | (c["m_score"] >= t["minScore"]))
        & (c["lifecycle_status"] != "CHURNED")
        & (c["order_count"] >= t["minOrders"])
        # Customers without a gap yet (one purchase day) can never exceed it.
        & (c["recency_days"] > t["gapMultiple"] * c["median_gap"].astype(float).fillna(math.inf))
        & (c["recency_days"] > t["minRecencyDays"])
    )
    n = int(mask.sum())
    if n < t["minCustomers"]:
        return None
    affected = _affected(ctx, mask)
    rows = c[mask]
    recency = float(rows["recency_days"].median())
    gap = float(rows["median_gap"].median())
    stake = int(affected.sum())
    return Finding(
        CHURN_RISK.key, CHURN_RISK.version, "all",
        f"{n} high-value customers are at risk of churning",
        "Protect revenue from customers who used to buy often or spend a lot but have gone quiet.",
        f"These customers have F or M scores of 4–5 and at least 3 orders, but have not bought "
        f"for more than 1.5× their usual interval (typically every {gap:.0f} days; now "
        f"{recency:.0f} days since the last purchase, median).",
        CHURN_RISK.action,
        {
            "affectedCustomers": n,
            "historicalRevenueCents": int(rows["historical_clv"].sum()),
            "medianDaysSinceLastOrder": recency,
            "medianUsualGapDays": gap,
            "shareOfLast12mRevenue": _share(stake, ctx.trailing_revenue),
        },
        affected, stake,
    )  # fmt: skip


REACTIVATION = RuleSpec(
    "reactivation_campaign", 1, "Win back valuable lapsed customers",
    "Hibernating and Lost customers whose historical CLV is at least the tenant's 75th "
    "percentile and who agreed to marketing. Fires with at least 20 customers.",
    "Reactivation campaign with an incentive; measure response against a holdout group.",
    {"clvPercentile": 0.75, "minCustomers": 20},
)  # fmt: skip


def reactivation_campaign(ctx: RuleContext) -> Finding | None:
    c = ctx.customers
    t = REACTIVATION.thresholds
    buyers = c[c["order_count"] > 0]
    if buyers.empty:
        return None
    p75 = float(buyers["historical_clv"].quantile(t["clvPercentile"]))
    consent = c["marketing_consent"].fillna(False).astype(bool)
    mask = c["segment_key"].isin(["hibernating", "lost"]) & (c["historical_clv"] >= p75) & consent
    n = int(mask.sum())
    if n < t["minCustomers"]:
        return None
    affected = _affected(ctx, mask)
    rows = c[mask]
    stake = int(affected.sum())
    return Finding(
        REACTIVATION.key, REACTIVATION.version, "hibernating_lost",
        f"{n} lapsed customers with high past spend can be won back",
        "Re-engage Hibernating and Lost customers who used to be among your best, and who agreed "
        "to hear from you.",
        f"Each of them spent at least as much as 75% of your buyers (the top quarter by lifetime "
        f"value), but they now sit in Hibernating or Lost. All {n} have marketing consent.",
        REACTIVATION.action,
        {
            "affectedCustomers": n,
            "historicalRevenueCents": int(rows["historical_clv"].sum()),
            "clvThresholdCents": round(p75),
            "medianDaysSinceLastOrder": float(rows["recency_days"].median()),
            "shareOfLast12mRevenue": _share(stake, ctx.trailing_revenue),
        },
        affected, stake,
    )  # fmt: skip


PROTECT = RuleSpec(
    "protect_champions", 1, "Protect your best customers",
    "Champions and Can't Lose Them bring at least 30% of trailing-12-month revenue.",
    "VIP treatment: early access, loyalty tier, thank-you outreach. Can't Lose Them first.",
    {"minRevenueShare": 0.30},
)  # fmt: skip


def protect_champions(ctx: RuleContext) -> Finding | None:
    c = ctx.customers
    mask = c["segment_key"].isin(["champions", "cant_lose_them"])
    if not mask.any() or ctx.trailing_revenue <= 0:
        return None
    affected = _affected(ctx, mask)
    stake = int(affected.sum())
    share = stake / ctx.trailing_revenue
    if share < PROTECT.thresholds["minRevenueShare"]:
        return None
    champions = int((c["segment_key"] == "champions").sum())
    cant_lose = int((c["segment_key"] == "cant_lose_them").sum())
    n = champions + cant_lose
    return Finding(
        PROTECT.key, PROTECT.version, "champions",
        f"{n} customers bring {_pct(share)} of last year's revenue",
        "Keep your most valuable customers buying: losing a few of them would show in revenue.",
        f"{champions} Champions and {cant_lose} Can't Lose Them customers ({_pct(n / len(c))} of "
        f"customers) accounted for {_pct(share)} of net revenue in the last 12 months.",
        PROTECT.action,
        {
            "affectedCustomers": n,
            "champions": champions,
            "cantLoseThem": cant_lose,
            "shareOfLast12mRevenue": share,
            "shareOfCustomers": n / len(c),
        },
        affected, stake,
    )  # fmt: skip


LOYALTY = RuleSpec(
    "loyalty_programme", 1, "Loyalty programme opportunity",
    "Loyal Customers and Potential Loyalists are at least 15% of active customers.",
    "Introduce or promote a points or tier programme to move them toward Champions.",
    {"minShareOfActive": 0.15},
)  # fmt: skip


def loyalty_programme(ctx: RuleContext) -> Finding | None:
    c = ctx.customers
    active = int((c["lifecycle_status"] == "ACTIVE").sum())
    mask = c["segment_key"].isin(["loyal", "potential_loyalists"])
    n = int(mask.sum())
    if active == 0 or n / active < LOYALTY.thresholds["minShareOfActive"]:
        return None
    affected = _affected(ctx, mask)
    stake = int(affected.sum())
    share = n / active
    return Finding(
        LOYALTY.key, LOYALTY.version, "loyal",
        f"{n} regular customers could become Champions",
        "A loyalty programme rewards customers who already come back, so they buy more often.",
        f"Loyal Customers and Potential Loyalists number {n}, {_pct(share)} of your {active} "
        f"active customers: a sizeable group already in the habit of returning.",
        LOYALTY.action,
        {
            "affectedCustomers": n,
            "activeCustomers": active,
            "shareOfActive": share,
            "shareOfLast12mRevenue": _share(stake, ctx.trailing_revenue),
        },
        affected, stake,
    )  # fmt: skip


SECOND_PURCHASE = RuleSpec(
    "second_purchase_window", 1, "Nudge one-time buyers now",
    "One-time buyers whose days since their first purchase are within the P25–P75 window of "
    "when returning customers made their second purchase. Needs 30 returning customers; fires "
    "with at least 20 buyers.",
    "Post-purchase nudge (recommendation, small incentive) during the window when second "
    "purchases usually happen.",
    {"minRepeaters": 30, "minCustomers": 20},
)  # fmt: skip


def second_purchase_window(ctx: RuleContext) -> Finding | None:
    c = ctx.customers
    t = SECOND_PURCHASE.thresholds
    p = ctx.purchases[ctx.purchases["customer_id"].notna()]
    p = p[p["day"] <= ts(ctx.as_of)][["customer_id", "day"]].drop_duplicates()
    p = p.sort_values(["customer_id", "day"])
    nth = p.groupby("customer_id").cumcount()
    first = p[nth == 0].set_index("customer_id")["day"]
    second = p[nth == 1].set_index("customer_id")["day"]
    gaps = (second - first.reindex(second.index)).dt.days
    if len(gaps) < t["minRepeaters"]:
        return None
    low, high = float(gaps.quantile(0.25)), float(gaps.quantile(0.75))
    since_first = (ts(ctx.as_of) - pd.to_datetime(c["first_day"])).dt.days
    mask = (c["purchase_days"] == 1) & since_first.between(low, high)
    n = int(mask.sum())
    if n < t["minCustomers"]:
        return None
    affected = _affected(ctx, mask)
    stake = int(affected.sum())
    return Finding(
        SECOND_PURCHASE.key, SECOND_PURCHASE.version, "all",
        f"{n} first-time buyers are in their second-purchase window",
        "Most second purchases happen in a predictable window after the first: a nudge now "
        "reaches customers while a return is still likely.",
        f"Half of your returning customers made their second purchase between {low:.0f} and "
        f"{high:.0f} days after the first. These {n} customers have bought once, {low:.0f}–"
        f"{high:.0f} days ago.",
        SECOND_PURCHASE.action,
        {
            "affectedCustomers": n,
            "windowStartDays": low,
            "windowEndDays": high,
            "returningCustomers": len(gaps),
            "shareOfLast12mRevenue": _share(stake, ctx.trailing_revenue),
        },
        affected, stake,
    )  # fmt: skip


RETENTION = RuleSpec(
    "retention_decline", 1, "Retention dropped",
    "Retention in the last complete period (month, or quarter when customers buy less than "
    "every 60 days) is significantly below the pooled previous three periods: one-sided "
    "two-proportion z-test p < 0.05, both bases ≥ 100, and a drop of at least 3 points.",
    "Investigate causes (product, price, service changes in the period); review the churned list.",
    {"alpha": 0.05, "minBase": 100, "minDropPoints": 0.03, "highDropPoints": 0.05},
)  # fmt: skip


def two_proportion_z(x1: int, n1: int, x0: int, n0: int) -> tuple[float, float] | None:
    """z and one-sided p-value for H1: p1 < p0, with the pooled standard error (§9)."""
    if n1 == 0 or n0 == 0:
        return None
    pooled = (x1 + x0) / (n1 + n0)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n0))
    if se == 0:
        return None
    z = (x1 / n1 - x0 / n0) / se
    return z, 0.5 * math.erfc(-z / math.sqrt(2))


def _complete_buckets(as_of: date, grain: Grain, count: int, week_start: str) -> list[Period]:
    """The last `count` buckets that ended on or before `as_of`."""
    end = floor_to_grain(as_of + timedelta(days=1), grain, week_start)  # type: ignore[arg-type]
    months = 3 if grain == "quarter" else 1
    start = add_months(end, -months * count) if grain != "week" else end - timedelta(weeks=count)
    return whole_buckets(Period(start, end), grain, week_start)[-count:]


def retention_decline(ctx: RuleContext) -> Finding | None:
    t = RETENTION.thresholds
    grain: Grain = recommended_grain(ctx.purchases)["grain"]
    buckets = _complete_buckets(ctx.as_of, grain, 4, ctx.settings.week_start)
    if len(buckets) < 4:
        return None
    ratios = [retention(ctx.purchases, b) for b in buckets]
    current, previous = ratios[-1], ratios[:-1]
    x0 = sum(r.numerator for r in previous)
    n0 = sum(r.denominator for r in previous)
    if current.denominator < t["minBase"] or n0 < t["minBase"]:
        return None
    test = two_proportion_z(current.numerator, current.denominator, x0, n0)
    if test is None:
        return None
    z, p_value = test
    rate, baseline = current.numerator / current.denominator, x0 / n0
    drop = baseline - rate
    if p_value >= t["alpha"] or drop < t["minDropPoints"]:
        return None
    period = buckets[-1]
    ids = ctx.purchases["customer_id"]
    days = ctx.purchases["day"]
    prev = period.previous()
    base = set(ids[(days >= ts(prev.start)) & (days < ts(prev.end)) & ids.notna()])
    came_back = set(ids[(days >= ts(period.start)) & (days < ts(period.end)) & ids.notna()])
    lost = base - came_back
    mask = ctx.customers["customer_id"].isin(lost)
    affected = _affected(ctx, mask)
    stake = int(affected.sum())
    finding = Finding(
        RETENTION.key, RETENTION.version, grain,
        f"Retention fell to {_pct(rate)} in the last {grain}",
        "Fewer of last period's buyers came back than usual: something may have changed.",
        f"{current.numerator} of {current.denominator} customers who bought in the previous "
        f"{grain} bought again ({_pct(rate)}), against {_pct(baseline)} over the three "
        f"{grain}s before ({drop * 100:.1f} points lower; z = {z:.2f}, p = {p_value:.3f}). "
        f"A drop this large is unlikely to be chance alone.",
        RETENTION.action,
        {
            "affectedCustomers": len(affected),
            "grain": grain,
            "periodStart": period.start.isoformat(),
            "periodEnd": period.end.isoformat(),
            "currentRate": rate,
            "baselineRate": baseline,
            "dropPoints": drop,
            "currentBase": current.denominator,
            "baselineBase": n0,
            "zScore": z,
            "pValue": p_value,
            "series": [
                {"period": b.start.isoformat(), "rate": r.value, "base": r.denominator}
                for b, r in zip(buckets, ratios, strict=True)
            ],
            "shareOfLast12mRevenue": _share(stake, ctx.trailing_revenue),
        },
        affected, stake,
        extra_high=drop >= t["highDropPoints"],
    )  # fmt: skip
    return finding


RULES: tuple[tuple[RuleSpec, Callable[[RuleContext], Finding | None]], ...] = (
    (CHURN_RISK, churn_risk_high_value),
    (REACTIVATION, reactivation_campaign),
    (PROTECT, protect_champions),
    (LOYALTY, loyalty_programme),
    (SECOND_PURCHASE, second_purchase_window),
    (RETENTION, retention_decline),
)
RULE_CATALOGUE = [spec.to_dict() for spec, _ in RULES]

"""Recommendation rules at their threshold boundaries, priority scoring and lifecycle."""

from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

import pandas as pd
import pytest

from insights.metrics.core import customer_metrics
from insights.metrics.rfm import SegmentConfig, rfm
from insights.recommendations.engine import (
    Stored,
    build_context,
    evaluate,
    prioritise,
    reconcile,
)
from insights.recommendations.rules import (
    RULE_CATALOGUE,
    Finding,
    RuleContext,
    churn_risk_high_value,
    loyalty_programme,
    protect_champions,
    reactivation_campaign,
    retention_decline,
    second_purchase_window,
    two_proportion_z,
)
from tests.fixtures import SETTINGS
from tests.test_rfm import CUT_POINTS, DEFAULT

AS_OF = date(2026, 11, 5)
NO_PURCHASES = pd.DataFrame(
    {
        "customer_id": pd.Series(dtype="object"),
        "day": pd.Series(dtype="datetime64[ns]"),
        "orders": pd.Series(dtype="int64"),
        "net": pd.Series(dtype="int64"),
    }
)


def customer(i: int, **overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "customer_id": f"C{i}",
        "order_count": 5,
        "purchase_days": 5,
        "recency_days": 20,
        "median_gap": 30.0,
        "lifecycle_status": "ACTIVE",
        "historical_clv": 1000,
        "f_score": 2,
        "m_score": 2,
        "segment_key": "need_attention",
        "marketing_consent": False,
        "first_day": pd.Timestamp("2025-01-01"),
        "value_12m": 100,
    }
    row.update(overrides)
    return row


def ctx(
    rows: list[dict[str, Any]],
    purchases: pd.DataFrame = NO_PURCHASES,
    trailing: int | None = None,
) -> RuleContext:
    frame = pd.DataFrame(rows)
    total = int(frame["value_12m"].sum()) if trailing is None else trailing
    return RuleContext(AS_OF, frame, purchases, total, SETTINGS)


# ───────────── churn_risk_high_value ─────────────

AT_RISK = {"f_score": 4, "recency_days": 46, "median_gap": 30.0, "lifecycle_status": "AT_RISK"}


def test_churn_risk_fires_at_ten_customers() -> None:
    rows = [customer(i, **AT_RISK) for i in range(10)] + [customer(99)]
    finding = churn_risk_high_value(ctx(rows))
    assert finding is not None
    assert finding.metrics["affectedCustomers"] == 10
    assert set(finding.customers.index) == {f"C{i}" for i in range(10)}
    assert finding.revenue_at_stake == 1000
    assert churn_risk_high_value(ctx(rows[:9])) is None


@pytest.mark.parametrize(
    "override",
    [
        {"recency_days": 45},  # exactly 1.5 × the 30-day gap: not beyond it
        {"recency_days": 30, "median_gap": 10.0},  # not more than 30 days
        {"lifecycle_status": "CHURNED"},
        {"order_count": 2},
        {"f_score": 3},
        {"median_gap": None},
    ],
)
def test_churn_risk_boundaries(override: dict[str, Any]) -> None:
    rows = [customer(i, **{**AT_RISK, **override}) for i in range(10)]
    assert churn_risk_high_value(ctx(rows)) is None


def test_churn_risk_accepts_high_monetary_score() -> None:
    rows = [customer(i, **{**AT_RISK, "f_score": 1, "m_score": 5}) for i in range(10)]
    assert churn_risk_high_value(ctx(rows)) is not None


# ───────────── reactivation_campaign ─────────────


def test_reactivation_needs_high_past_value_and_consent() -> None:
    lapsed = {"segment_key": "lost", "historical_clv": 5000, "marketing_consent": True}
    rows = [customer(i, **lapsed) for i in range(20)] + [customer(100 + i) for i in range(60)]
    finding = reactivation_campaign(ctx(rows))
    assert finding is not None
    assert finding.metrics["affectedCustomers"] == 20
    rows[0]["marketing_consent"] = False
    assert reactivation_campaign(ctx(rows)) is None
    low_value = [customer(i, **{**lapsed, "historical_clv": 10}) for i in range(20)]
    assert reactivation_campaign(ctx(low_value + [customer(99, historical_clv=10**6)] * 20)) is None


# ───────────── protect_champions / loyalty_programme ─────────────


def test_protect_champions_at_thirty_percent_of_revenue() -> None:
    rows = [customer(0, segment_key="champions", value_12m=300)] + [
        customer(i, value_12m=100) for i in range(1, 8)
    ]
    finding = protect_champions(ctx(rows, trailing=1000))
    assert finding is not None
    assert finding.metrics["shareOfLast12mRevenue"] == pytest.approx(0.30)
    assert protect_champions(ctx(rows, trailing=1001)) is None


def test_loyalty_programme_at_fifteen_percent_of_active() -> None:
    rows = [customer(i, segment_key="loyal") for i in range(3)] + [
        customer(i) for i in range(3, 20)
    ]
    finding = loyalty_programme(ctx(rows))  # 3 of 20 active = 15%
    assert finding is not None
    assert finding.metrics["shareOfActive"] == pytest.approx(0.15)
    rows.append(customer(20))  # 3 of 21 < 15%
    assert loyalty_programme(ctx(rows)) is None


# ───────────── second_purchase_window ─────────────


def purchases(rows: list[tuple[str, str]]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["customer_id", "day"])
    df["day"] = pd.to_datetime(df["day"])
    df["orders"] = 1
    df["net"] = 100
    return df


def test_second_purchase_window_targets_one_time_buyers_inside_it() -> None:
    first = pd.Timestamp("2026-01-01")
    # 40 returning customers came back after 10…49 days: P25 = 19.75, P75 = 39.25.
    rows = [(f"R{i}", str(first.date())) for i in range(40)]
    rows += [(f"R{i}", str((first + pd.Timedelta(days=10 + i)).date())) for i in range(40)]
    ago = [20] * 10 + [39] * 10 + [19, 40, 100]  # days since the first purchase
    buyers = [
        customer(i, purchase_days=1, first_day=pd.Timestamp(AS_OF) - pd.Timedelta(days=d))
        for i, d in enumerate(ago)
    ]
    finding = second_purchase_window(ctx(buyers, purchases(rows)))
    assert finding is not None
    assert finding.metrics["windowStartDays"] == pytest.approx(19.75)
    assert finding.metrics["windowEndDays"] == pytest.approx(39.25)
    assert finding.metrics["affectedCustomers"] == 20
    assert second_purchase_window(ctx(buyers[1:], purchases(rows))) is None


def test_second_purchase_window_needs_enough_returning_customers() -> None:
    first = pd.Timestamp("2026-01-01")
    rows = [(f"R{i}", str(first.date())) for i in range(29)]
    rows += [(f"R{i}", str((first + pd.Timedelta(days=20)).date())) for i in range(29)]
    buyers = [
        customer(i, purchase_days=1, first_day=pd.Timestamp(AS_OF) - pd.Timedelta(days=20))
        for i in range(30)
    ]
    assert second_purchase_window(ctx(buyers, purchases(rows))) is None


# ───────────── retention_decline ─────────────


def test_two_proportion_z_reference() -> None:
    z, p = two_proportion_z(40, 100, 150, 300)  # type: ignore[misc]
    assert z == pytest.approx(-1.7342, abs=1e-4)
    assert p == pytest.approx(0.04144, abs=1e-4)
    assert two_proportion_z(0, 0, 1, 10) is None


def monthly(returning_in_october: int, base: int = 200) -> pd.DataFrame:
    """`base` customers buy every month June–September; some of them in October."""
    rows = []
    for i in range(base):
        for month in (6, 7, 8, 9):
            rows.append((f"C{i}", f"2026-{month:02d}-{5 + i % 20:02d}"))
        if i < returning_in_october:
            rows.append((f"C{i}", f"2026-10-{5 + i % 20:02d}"))
    return purchases(rows)


def test_retention_decline_fires_on_a_significant_drop() -> None:
    p = monthly(100)
    rows = [customer(i, value_12m=500) for i in range(200)]
    finding = retention_decline(ctx(rows, p))
    assert finding is not None
    assert finding.metrics["periodStart"] == "2026-10-01"
    assert finding.metrics["currentRate"] == pytest.approx(0.5)
    assert finding.metrics["baselineRate"] == pytest.approx(1.0)
    assert finding.metrics["affectedCustomers"] == 100  # the base customers who did not return
    assert finding.extra_high
    assert [s["period"] for s in finding.metrics["series"]] == [
        "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"
    ]  # fmt: skip


@pytest.mark.parametrize("returning", [200, 196])
def test_retention_decline_ignores_small_or_no_drops(returning: int) -> None:
    # 196 of 200 is a 2-point drop: below the 3-point practical threshold.
    rows = [customer(i) for i in range(200)]
    assert retention_decline(ctx(rows, monthly(returning))) is None


def test_retention_decline_needs_a_base_of_one_hundred() -> None:
    rows = [customer(i) for i in range(99)]
    assert retention_decline(ctx(rows, monthly(10, base=99))) is None


# ───────────── priority ─────────────


def finding(stake: int, customers: int, **kwargs: Any) -> Finding:
    ids = pd.Series([1] * customers, index=[f"C{i}" for i in range(customers)])
    return Finding("x", 1, "all", "t", "o", "e", "a", {}, ids, stake, **kwargs)


@pytest.mark.parametrize(
    ("stake", "priority"), [(50, "HIGH"), (49, "MEDIUM"), (10, "MEDIUM"), (9, "LOW")]
)
def test_priority_from_share_of_revenue(stake: int, priority: str) -> None:
    assert prioritise(finding(stake, 100), 1000).priority == priority


def test_priority_score_is_impact_times_confidence() -> None:
    scored = prioritise(finding(100, 25), 1000)
    assert scored.priority_score == pytest.approx(0.1 * 0.25)
    assert prioritise(finding(0, 5, extra_high=True), 1000).priority == "HIGH"


def test_catalogue_lists_six_rules() -> None:
    assert [r["key"] for r in RULE_CATALOGUE] == [
        "churn_risk_high_value",
        "reactivation_campaign",
        "protect_champions",
        "loyalty_programme",
        "second_purchase_window",
        "retention_decline",
    ]


# ───────────── lifecycle ─────────────

NOW = datetime(2026, 11, 16, 7, tzinfo=UTC)


def stored(status: str, *, days_ago: int = 1, revenue: int | None = 100, missed: int = 0) -> Stored:
    return Stored(UUID(int=1), "x:all", status, NOW - timedelta(days=days_ago), revenue, missed)


def test_new_findings_insert_and_existing_open_ones_update() -> None:
    plan = reconcile([], [finding(100, 10)], NOW)
    assert len(plan.inserts) == 1
    plan = reconcile([stored("OPEN")], [finding(100, 10)], NOW)
    assert plan.inserts == []
    assert [(u[0], u[2]) for u in plan.updates] == [(UUID(int=1), False)]
    acknowledged = reconcile([stored("ACKNOWLEDGED")], [finding(100, 10)], NOW)
    assert acknowledged.updates[0][2] is False


def test_open_recommendations_expire_after_two_missed_runs() -> None:
    first = reconcile([stored("OPEN", missed=0)], [], NOW)
    assert first.missed == [UUID(int=1)]
    assert first.expired == []
    second = reconcile([stored("OPEN", missed=1)], [], NOW)
    assert second.expired == [UUID(int=1)]
    assert reconcile([stored("DISMISSED")], [], NOW).expired == []
    assert reconcile([stored("EXPIRED")], [finding(1, 1)], NOW).updates[0][2] is True


@pytest.mark.parametrize(
    ("days_ago", "revenue_now", "reopen"),
    [(89, 149, False), (90, 100, True), (10, 150, True), (10, 149, False)],
)
def test_dismissal_cooldown(days_ago: int, revenue_now: int, reopen: bool) -> None:
    plan = reconcile([stored("DISMISSED", days_ago=days_ago)], [finding(revenue_now, 10)], NOW)
    assert plan.updates[0][2] is reopen


def test_done_reopens_after_thirty_days() -> None:
    assert reconcile([stored("DONE", days_ago=29)], [finding(100, 1)], NOW).updates[0][2] is False
    assert reconcile([stored("DONE", days_ago=30)], [finding(100, 1)], NOW).updates[0][2] is True


# ───────────── end to end on generated data ─────────────


def test_planted_vips_trigger_churn_risk() -> None:
    """Planted quiet VIPs (frequent, big spenders who stopped 60–150 days ago) are flagged."""
    from insights.data.loader import customer_since
    from insights.datagen import GeneratorConfig, generate

    end = date(2026, 10, 31)
    generated = generate(GeneratorConfig(customers=3000, seed=11, end_date=end))
    orders = generated.orders[generated.orders["status"].isin(["completed", "partially_refunded"])]
    frame = pd.DataFrame(
        {
            "customer_id": orders["customerExternalId"],
            "day": orders["orderedAt"].dt.tz_convert("UTC").dt.tz_localize(None).dt.normalize(),
            "orders": 1,
            "net": orders["grossCents"] - orders["discountCents"] - orders["refundedCents"],
        }
    )
    frame = frame.groupby(["customer_id", "day"], as_index=False, dropna=False).sum()
    raw = pd.DataFrame(
        {
            "customer_id": generated.customers["externalId"],
            "created_day": end,
            "registered_at": pd.to_datetime(generated.customers["registeredAt"]).dt.date,
            "marketing_consent": generated.customers["marketingConsent"],
        }
    )
    customers = customer_since(raw, frame)
    metrics = customer_metrics(frame, customers, end, SETTINGS)
    scored = rfm(frame, customers, end, CUT_POINTS, SegmentConfig.from_dict(DEFAULT))
    metrics = metrics.merge(scored.drop(columns=["recency_days"]), on="customer_id", how="left")
    findings, errors = evaluate(build_context(metrics, frame, customers, end, SETTINGS))
    assert errors == {}
    by_key = {f.rule_key: f for f in findings}
    churn = by_key["churn_risk_high_value"]
    quiet = set(generated.ground_truth["quiet_vip_customers"])
    assert len(quiet) >= 20
    assert len(quiet & set(churn.customers.index)) >= 0.8 * len(quiet)
    assert (churn.revenue_at_stake or 0) > 0

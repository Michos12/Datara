"""Frequency, CLV, journey and engagement golden tests, hand-computed from tests/fixtures.py.

Purchase occasions (today 2026-04-01):
    A 2026-01-10, 02-15, 03-05 (gaps 36, 18)  · B 2026-02-01  · C 2025-12-20, 2026-03-20 (gap 90)
    E 2025-06-01  · F 2025-11-15  · D never bought (registered 2026-02-10)
"""

from dataclasses import replace
from datetime import UTC, date, datetime
from uuid import UUID

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from hypothesis import given, settings
from hypothesis import strategies as st

from insights.api.app import create_app
from insights.data.loader import OrgData
from insights.metrics.behavior import cohort_months
from insights.metrics.engagement import (
    EngagementConfig,
    engaged_rate,
    engagement_scores,
    score_distribution,
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
    kaplan_meier,
    km_quantile,
    lifetime_totals,
    occasions,
    survival_at,
    time_to_second,
)
from insights.metrics.value_queries import (
    clv_query,
    engagement_query,
    frequency_query,
    journey_query,
)
from insights.periods import Period
from insights.service import AnalyticsService
from tests.fixtures import customers, org_data, purchases
from tests.test_overview import TOKEN, CountingLoader, FakeDb

TODAY = date(2026, 4, 1)
ORG = UUID("0193a2b4-0000-7000-8000-000000000001")

INTERACTIONS = [
    ("A", "2026-03-01", "EMAIL_CLICKED", "email", 1),
    ("A", "2026-03-02", "WEBSITE_VISIT", "web", 15),
    ("B", "2026-03-10", "EMAIL_OPENED", "email", 2),
    ("C", "2026-03-15", "SUPPORT_TICKET", "phone", 1),
    ("F", "2025-10-01", "REVIEW", "web", 1),
]


def interactions() -> pd.DataFrame:
    df = pd.DataFrame(INTERACTIONS, columns=["customer_id", "day", "type", "channel", "n"])
    df["day"] = pd.to_datetime(df["day"])
    return df.astype({"n": "int64"})


def with_interactions() -> OrgData:
    return replace(org_data(), interactions=interactions())


# ───────────── Kaplan–Meier ─────────────

# Reference: lifelines 0.30.0 KaplanMeierFitter().fit(D, E).survival_function_ at event times.
D = [5, 6, 6, 2, 4, 4, 8, 8, 8, 10, 12, 3, 3, 3, 7, 9, 1, 1, 11, 15]
E = [1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0]
LIFELINES = {
    1: 0.9, 2: 0.8500000000000002, 3: 0.7500000000000001, 4: 0.6964285714285716,
    5: 0.6383928571428574, 6: 0.5803571428571431, 7: 0.5158730158730159,
    8: 0.38690476190476203, 9: 0.38690476190476203, 10: 0.29017857142857156,
    11: 0.193452380952381, 12: 0.193452380952381, 15: 0.193452380952381,
}  # fmt: skip


def test_kaplan_meier_matches_lifelines() -> None:
    curve = kaplan_meier(pd.Series(D), pd.Series(E).astype(bool))
    for t, expected in LIFELINES.items():
        assert survival_at(curve, t) == pytest.approx(expected, abs=1e-12)
    assert survival_at(curve, 0) == 1.0
    # lifelines median_survival_time_ = 8.0: the first time S(t) ≤ 0.5.
    assert km_quantile(curve, 0.5) == 8
    assert int(curve["at_risk"].iloc[0]) == 20


@settings(max_examples=60)
@given(st.lists(st.tuples(st.integers(0, 400), st.booleans()), min_size=1, max_size=60))
def test_kaplan_meier_is_a_non_increasing_probability(rows: list[tuple[int, bool]]) -> None:
    curve = kaplan_meier(pd.Series([r[0] for r in rows]), pd.Series([r[1] for r in rows]))
    survival = curve["survival"].to_numpy()
    assert np.all((survival >= 0) & (survival <= 1))
    assert np.all(np.diff(survival) <= 1e-12)
    # Without censoring, KM is the empirical distribution.
    if all(r[1] for r in rows):
        last = max(r[0] for r in rows)
        assert survival_at(curve, last) == pytest.approx(0.0)


# ───────────── frequency ─────────────


def test_same_day_orders_are_one_occasion() -> None:
    p = pd.DataFrame(
        [("X", "2026-01-01", 2, 100), ("X", "2026-01-01", 1, 50), ("X", "2026-01-11", 1, 10)],
        columns=["customer_id", "day", "orders", "net"],
    )
    p["day"] = pd.to_datetime(p["day"])
    occ = occasions(p, TODAY)
    assert occ["n"].tolist() == [1, 2]
    assert occ["orders"].tolist() == [3, 1]
    assert occ["gap"].dropna().tolist() == [10]


def test_frequency_golden() -> None:
    occ = acquired_in(occasions(purchases(), TODAY), date(2025, 6, 1), date(2026, 4, 1))
    result = frequency(occ, cohort_months(date(2025, 12, 1), date(2026, 4, 1)), TODAY)
    assert result["customers"] == 5
    assert [b["count"] for b in result["orderCounts"]] == [3, 1, 1, 0, 0, 0, 0]
    assert result["repeat"]["repeated"] == 2
    assert result["repeat"]["rate"] == pytest.approx(0.4)
    assert result["repeat"]["lowSample"] is True
    assert result["gaps"]["count"] == 3
    assert result["gaps"]["median"] == 36
    assert result["gaps"]["p25"] == 27
    assert result["gaps"]["p75"] == 63
    assert [b["count"] for b in result["gaps"]["histogram"]][:5] == [0, 0, 1, 1, 1]
    december = result["byCohort"][0]
    assert (december["cohort"], december["size"], december["repeated"]) == ("2025-12", 1, 1)
    assert december["within90"] == 1.0  # Jan 1 + 90 days ≤ today
    assert result["byCohort"][1]["within90"] is None  # January cohort: not 90 days yet


def test_time_to_second_purchase_is_censoring_aware() -> None:
    occ = occasions(purchases(), TODAY)
    result = time_to_second(occ, TODAY)
    # Durations: A 36 ✓, C 90 ✓, B 59 censored, F 137 censored, E 304 censored.
    assert (result["customers"], result["repeated"], result["censored"]) == (5, 2, 3)
    within = {w["days"]: w["share"] for w in result["within"]}
    assert within[30] == 0
    assert within[60] == pytest.approx(0.2)
    assert within[90] == pytest.approx(1 - 0.8 * 2 / 3)
    # A naive "repeaters ÷ customers" would say 40%: KM accounts for B still waiting.
    assert within[365] > 0.4
    assert result["quantiles"] == {"p25": 90, "median": None, "p75": None}
    assert result["repeaters"]["median"] == 63
    assert result["curve"][0] == {"days": 0, "share": 0.0}
    # The curve runs to the last follow-up time (E, censored at 304 days).
    assert result["curve"][-1] == {"days": 304, "share": pytest.approx(1 - 0.8 * 2 / 3)}


# ───────────── CLV ─────────────


def test_clv_summary_and_distribution() -> None:
    totals = lifetime_totals(occasions(purchases(), TODAY))
    summary = clv_summary(totals)
    assert summary["customers"] == 5
    assert summary["mean"] == pytest.approx(1390 / 5)
    assert summary["median"] == 200
    assert summary["top10Share"] == pytest.approx(600 / 1390)
    bins = clv_distribution(totals)
    assert sum(b["count"] for b in bins) == 5
    assert bins[-1]["max"] is None
    assert clv_summary(pd.Series(dtype="int64"))["mean"] is None


def test_clv_by_cohort_shows_horizons_only_when_complete() -> None:
    occ = occasions(purchases(), TODAY)
    rows = clv_by_cohort(
        acquired_in(occ, date(2025, 12, 1), date(2026, 2, 1)),
        cohort_months(date(2025, 12, 1), date(2026, 2, 1)),
        TODAY,
    )
    december, january = rows
    assert december["size"] == 1
    assert december["toDate"] == 200
    # C: 80 on day 0; the 120 on 2026-03-20 is day 90, outside the first 90 days.
    assert december["withinDays"] == {"90": 80, "180": None, "365": None}
    assert january["toDate"] == 600
    assert january["withinDays"]["90"] is None


def test_clv_by_segment() -> None:
    totals = lifetime_totals(occasions(purchases(), TODAY))
    rows = clv_by_segment(totals, {"A": "champions", "C": "champions", "B": None, "E": "lost"})
    assert [(r["segment"], r["customers"], r["mean"]) for r in rows] == [
        ("lost", 1, 500), ("champions", 2, 400), (None, 1, 50)
    ]  # fmt: skip
    assert sum(r["revenueShare"] for r in rows) == pytest.approx(1)
    assert clv_by_segment(totals, {}) == []


# ───────────── journey ─────────────


def test_journey_funnel_and_timing() -> None:
    occ = occasions(purchases(), TODAY)
    result = journey(occ, customers(), date(2026, 1, 1), date(2026, 4, 1), TODAY, 90)
    counts = {s["stage"]: s["customers"] for s in result["stages"]}
    # Since: A 01-10, B 01-15 (registered), D 02-10 (prospect); C, E, F started earlier.
    assert counts == {"registered": 3, "first": 2, "second": 1, "third": 1, "active": 2}
    first = next(s for s in result["stages"] if s["stage"] == "first")
    assert first["conversion"]["rate"] == pytest.approx(2 / 3)
    timing = {t["to"]: t for t in result["timing"]}
    # registered → 1st: A 0 days, B 17 days, D censored at 50 days: KM median 17.
    assert timing["first"]["medianDays"] == 17
    assert timing["first"]["censored"] == 1
    assert timing["second"]["reached"] == 1


def test_interactions_before_first_purchase() -> None:
    occ = occasions(purchases(), TODAY)
    i = pd.DataFrame(
        [("B", "2026-01-20", "EMAIL_CLICKED", "email", 1),
         ("B", "2026-02-01", "WEBSITE_VISIT", "web", 1),
         ("A", "2025-11-01", "WEBSITE_VISIT", "web", 1)],  # more than 30 days before
        columns=["customer_id", "day", "type", "channel", "n"],
    )  # fmt: skip
    i["day"] = pd.to_datetime(i["day"])
    result = before_first_purchase(occ, i, date(2026, 1, 1), date(2026, 4, 1))
    assert result["firstPurchasers"] == 2
    assert result["withInteractions"] == 1
    assert {t["type"]: t["customers"] for t in result["types"]} == {
        "email_clicked": 1,
        "website_visit": 1,
    }


# ───────────── engagement ─────────────

AS_OF = date(2026, 3, 31)


def test_engagement_score_formula() -> None:
    scores = engagement_scores(interactions(), AS_OF).set_index("customer_id")
    # A: 3 × 1 click + 1 × min(15, 10) visits = 13. B: 1 × 2 opens = 2. C: ticket weighs 0.
    # F's review is older than 90 days.
    assert scores["raw"].to_dict() == {"A": 13.0, "B": 2.0}
    assert scores["score"].to_dict() == {"A": 100, "B": 50}


def test_engagement_score_is_deterministic() -> None:
    base = engagement_scores(interactions(), AS_OF)
    shuffled = interactions().sample(frac=1, random_state=7).reset_index(drop=True)
    pd.testing.assert_frame_equal(base, engagement_scores(shuffled, AS_OF))
    heavier = EngagementConfig.from_settings({"weights": {"support_ticket": 2}, "cap": 5})
    custom = engagement_scores(interactions(), AS_OF, heavier).set_index("customer_id")
    assert custom["raw"].to_dict() == {"A": 8.0, "B": 2.0, "C": 2.0}


def test_engagement_config_ignores_invalid_values() -> None:
    config = EngagementConfig.from_settings({"weights": {"REVIEW": 99, "NOPE": 1}, "cap": 0})
    assert config.weight_map["REVIEW"] == 5
    assert config.cap == 10


def test_engaged_rate_and_volume() -> None:
    rate = engaged_rate(purchases(), interactions(), AS_OF, 180)
    # Alive (last purchase within 180 days): A, B, C, F. Interacted in the last 90 days: A, B, C.
    assert (rate["engaged"], rate["alive"]) == (3, 4)
    march = volume(interactions(), Period(date(2026, 3, 1), date(2026, 4, 1)))
    assert march["total"] == 19
    assert march["customers"] == 3
    assert {r["type"]: r["count"] for r in march["byType"]}["website_visit"] == 15
    assert march["byChannel"][0] == {"channel": "web", "count": 15}
    scores = engagement_scores(interactions(), AS_OF)
    assert sum(b["count"] for b in score_distribution(scores)) == 2


# ───────────── queries and endpoints ─────────────

NOW = datetime(2026, 4, 1, 15, tzinfo=UTC)


def test_queries_carry_the_envelope() -> None:
    period = Period(date(2025, 6, 1), date(2026, 4, 1))
    freq = frequency_query(org_data(), period, now=NOW)
    assert freq["meta"]["metric"] == "repeat_purchase_rate"
    assert any(w["code"] == "CENSORED" for w in freq["meta"]["warnings"])
    clv = clv_query(org_data(), {"A": "champions"}, period, now=NOW)
    assert clv["meta"]["kind"] == "measured"
    assert clv["data"]["bySegment"][0]["segment"] == "champions"
    journey_result = journey_query(org_data(), Period(date(2026, 1, 1), date(2026, 4, 1)), NOW)
    assert journey_result["data"]["beforeFirstPurchase"]["types"] == []
    empty = engagement_query(org_data(), now=NOW)
    assert any(w["code"] == "NO_INTERACTIONS" for w in empty["meta"]["warnings"])
    full = engagement_query(with_interactions(), Period(date(2026, 3, 1), date(2026, 4, 1)), NOW)
    assert full["meta"]["asOf"] == "2026-03-31"
    assert full["data"]["engagedRate"]["engaged"] == 3
    assert full["data"]["config"]["weights"]["email_clicked"] == 3


def http() -> TestClient:
    return TestClient(
        create_app(
            version="x",
            service_token=TOKEN,
            database=FakeDb(),
            analytics=AnalyticsService(CountingLoader()),
        )
    )


@pytest.mark.parametrize("kind", ["frequency", "clv", "journey", "engagement"])
def test_value_endpoints(kind: str) -> None:
    headers = {"X-Service-Token": TOKEN}
    body = {"organizationId": str(ORG), "start": "2026-01-01", "end": "2026-04-01"}
    response = http().post(f"/internal/query/{kind}", json=body, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["meta"]["currency"] == "USD"
    segment = http().post(
        f"/internal/query/{kind}", json={**body, "segment": "loyal"}, headers=headers
    )
    assert any(w["code"] == "SEGMENT_FILTER" for w in segment.json()["meta"]["warnings"])
    assert http().post(f"/internal/query/{kind}", json=body).status_code == 401
    bad = http().post(
        f"/internal/query/{kind}", json={**body, "end": "2025-01-01"}, headers=headers
    )
    assert bad.status_code == 422


def test_datagen_interactions_precede_purchases() -> None:
    from insights.datagen import GeneratorConfig, generate

    data = generate(GeneratorConfig(customers=300, seed=5, end_date=date(2026, 10, 31)))
    assert len(data.interactions) > 0
    assert set(data.interactions["customerExternalId"]) <= set(data.customers["externalId"])
    assert data.interactions["externalId"].is_unique
    assert data.ground_truth["interactions"] == len(data.interactions)

"""Retention, churn and cohort golden tests, hand-computed from tests/fixtures.py.

Churn threshold 180 days. Churn dates (last purchase + 180, no purchase in between):
E 2025-11-28 · F 2026-05-14 · B 2026-07-31 · A 2026-09-01 · C 2026-09-16
(C's 2025-12-20 → 2026-03-20 gap is 90 days, so C never lapsed in between).
"""

from datetime import UTC, date, datetime
from uuid import UUID

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from hypothesis import given
from hypothesis import strategies as st

from insights.api.app import create_app
from insights.metrics.behavior import (
    churn_by_segment,
    churn_series,
    churned_customers,
    cohort_matrix,
    cohort_months,
    median_gap_days,
    reactivated,
    recommended_grain,
    retention_series,
    snap_to_grain,
    whole_buckets,
    wilson,
)
from insights.metrics.behavior_queries import cohorts_query, retention_query
from insights.metrics.rfm import SegmentConfig, rfm
from insights.periods import Period
from insights.service import AnalyticsService
from tests.fixtures import SETTINGS, customers, org_data, purchases
from tests.test_overview import TOKEN, CountingLoader, FakeDb
from tests.test_rfm import CUT_POINTS, DEFAULT

ORG = UUID("0193a2b4-0000-7000-8000-000000000001")


def months(start: date, end: date) -> list[Period]:
    return whole_buckets(Period(start, end), "month")


def test_wilson_interval() -> None:
    assert wilson(0, 0) is None
    low, high = wilson(5, 10)  # type: ignore[misc]
    assert low == pytest.approx(0.2366, abs=1e-4)
    assert high == pytest.approx(0.7634, abs=1e-4)
    assert wilson(0, 10)[0] == 0.0  # type: ignore[index]
    assert wilson(10, 10)[1] == pytest.approx(1.0)  # type: ignore[index]


@given(st.integers(0, 500), st.integers(1, 500))
def test_wilson_contains_the_observed_rate(successes: int, trials: int) -> None:
    successes = min(successes, trials)
    low, high = wilson(successes, trials)  # type: ignore[misc]
    assert 0 <= low <= successes / trials <= high <= 1


def test_retention_series_month_by_month() -> None:
    rows = retention_series(
        purchases(), months(date(2026, 1, 1), date(2026, 4, 1)), date(2026, 6, 1)
    )
    # Jan: of December's buyers {C}, nobody bought. Feb: of {A}, A did. Mar: of {A, B}, A did.
    assert [(r["period"], r["retained"], r["base"]) for r in rows] == [
        ("2026-01-01", 0, 1),
        ("2026-02-01", 1, 1),
        ("2026-03-01", 1, 2),
    ]
    assert rows[2]["rate"] == 0.5
    assert rows[2]["low"] < 0.5 < rows[2]["high"]
    assert all(r["lowSample"] and not r["partial"] for r in rows)


def test_snapping_widens_to_whole_buckets() -> None:
    assert snap_to_grain(Period(date(2026, 2, 10), date(2026, 5, 3)), "quarter") == Period(
        date(2026, 1, 1), date(2026, 7, 1)
    )
    weeks = whole_buckets(Period(date(2026, 3, 4), date(2026, 3, 12)), "week")
    assert [w.start for w in weeks] == [date(2026, 3, 2), date(2026, 3, 9)]
    assert all(w.days == 7 for w in weeks)


def test_churn_series_recognises_churn_on_the_churn_date() -> None:
    rows = churn_series(
        purchases(),
        months(date(2025, 11, 1), date(2026, 1, 1)) + months(date(2026, 5, 1), date(2026, 6, 1)),
        SETTINGS.churn_days,
        date(2026, 6, 20),
    )
    by_month = {r["period"]: (r["churned"], r["base"]) for r in rows}
    # Nov 2025: E (alive since 06-01) churns on 11-28. Dec: only F is alive, nobody churns.
    assert by_month["2025-11-01"] == (1, 1)
    assert by_month["2025-12-01"] == (0, 1)
    # May 2026: A, B, C and F are alive on May 1; F churns on 05-14.
    assert by_month["2026-05-01"] == (1, 4)


def test_churn_is_not_counted_before_it_happens() -> None:
    (row,) = churn_series(
        purchases(), months(date(2026, 5, 1), date(2026, 6, 1)), 180, date(2026, 5, 10)
    )
    assert row["churned"] == 0  # F's churn date (05-14) has not come yet
    assert row["partial"] is True


def test_reactivation_after_a_gap_longer_than_the_threshold() -> None:
    p = pd.DataFrame(
        {
            "customer_id": ["X", "X", "Y", "Y"],
            "day": pd.to_datetime(["2025-01-01", "2025-09-01", "2025-01-01", "2025-05-01"]),
            "orders": [1, 1, 1, 1],
            "net": [10, 10, 10, 10],
        }
    )
    # X waited 243 days (> 180): churned on 2025-06-30, reactivated in September. Y waited 120.
    assert reactivated(p, Period(date(2025, 9, 1), date(2025, 10, 1)), 180) == {"X"}
    assert reactivated(p, Period(date(2025, 5, 1), date(2025, 6, 1)), 180) == set()
    (june,) = churn_series(p, months(date(2025, 6, 1), date(2025, 7, 1)), 180, date(2026, 1, 1))
    assert (june["churned"], june["base"]) == (1, 2)


def test_churned_customers_list() -> None:
    rows = churned_customers(
        purchases(), Period(date(2025, 11, 1), date(2026, 6, 1)), 180, date(2026, 5, 31)
    )
    assert list(rows["customer_id"]) == ["E", "F"]  # highest lifetime value first
    e = rows.iloc[0]
    assert e["last_purchase"] == pd.Timestamp("2025-06-01")
    assert e["churn_date"] == pd.Timestamp("2025-11-28")
    assert (e["orders"], e["net"]) == (1, 500)


def test_churned_customers_match_the_monthly_count() -> None:
    for start, end in [
        (date(2025, 11, 1), date(2025, 12, 1)),
        (date(2026, 5, 1), date(2026, 6, 1)),
    ]:
        period = Period(start, end)
        (row,) = churn_series(purchases(), [period], 180, date(2026, 12, 31))
        listed = churned_customers(purchases(), period, 180, period.last_day)
        assert len(listed) == row["churned"]


def test_churn_by_segment_uses_segments_before_the_period() -> None:
    config = SegmentConfig.from_dict(DEFAULT)
    period = Period(date(2026, 3, 1), date(2026, 7, 1))
    rows = churn_by_segment(
        purchases(), customers(), period, 180, date(2026, 6, 30), CUT_POINTS, config
    )
    assert sum(r["base"] for r in rows) == 4  # A, B, C, F alive on March 1
    assert sum(r["churned"] for r in rows) == 1  # F
    before = rfm(purchases(), customers(), date(2026, 2, 28), CUT_POINTS, config)
    f_segment = before.set_index("customer_id").loc["F", "segment_key"]
    (f_row,) = [r for r in rows if r["segment"] == f_segment]
    assert f_row["churned"] == 1


def test_recommended_grain_from_the_median_gap() -> None:
    # A's gaps 36 and 18 days (median 27), C's gap 90 days: median of medians 58.5.
    assert median_gap_days(purchases()) == 58.5
    assert recommended_grain(purchases())["grain"] == "month"
    slow = pd.DataFrame(
        {
            "customer_id": ["X", "X"],
            "day": pd.to_datetime(["2025-01-01", "2025-05-01"]),
            "orders": [1, 1],
            "net": [1, 1],
        }
    )
    assert recommended_grain(slow) == {"grain": "quarter", "medianGapDays": 120.0}


def test_cohort_matrix_golden() -> None:
    # Cohorts: C (Dec 2025), A (Jan 2026), B (Feb 2026). Today 2026-04-15: April is incomplete.
    result = cohort_matrix(
        purchases(), cohort_months(date(2025, 12, 1), date(2026, 3, 1)), 4, date(2026, 4, 15)
    )
    dec, jan, feb = result["cohorts"]
    assert [c["cohort"] for c in result["cohorts"]] == ["2025-12", "2026-01", "2026-02"]
    assert dec["retention"] == [1.0, 0.0, 0.0, 1.0]
    assert jan["retention"] == [1.0, 1.0, 1.0, None]
    assert feb["retention"] == [1.0, 0.0, None, None]
    assert jan["revenuePerCustomer"] == [100, 200, 300, None]
    assert jan["cumulativeRevenuePerCustomer"] == [100, 300, 600, None]
    assert dec["cumulativeRevenuePerCustomer"] == [80, 80, 80, 200]
    assert all(c["size"] == 1 and c["lowSample"] for c in result["cohorts"])

    average = result["average"]
    assert average["size"] == 3
    assert average["retention"] == [1.0, pytest.approx(1 / 3), 0.5, 1.0]
    # k = 2 averages only the cohorts whose month 2 is over (Dec and Jan): (80 + 600) / 2.
    assert average["cumulativeRevenuePerCustomer"][2] == 340


def test_empty_cohort_and_incomplete_months_are_null_not_zero() -> None:
    result = cohort_matrix(
        purchases(), cohort_months(date(2026, 4, 1), date(2026, 5, 1)), 3, date(2026, 6, 15)
    )
    (april,) = result["cohorts"]
    assert april["size"] == 0
    assert april["retention"] == [None, None, None]
    assert result["average"]["retention"] == [None, None, None]


def test_cohort_months_start_on_whole_months() -> None:
    assert cohort_months(date(2026, 1, 15), date(2026, 4, 1)) == [
        date(2026, 2, 1),
        date(2026, 3, 1),
    ]


def test_queries_default_to_the_last_twelve_complete_months() -> None:
    now = datetime(2026, 4, 20, 15, tzinfo=UTC)
    result = retention_query(org_data(), now=now)
    assert result["meta"]["period"] == {
        "start": "2025-04-01",
        "end": "2026-04-01",
        "grain": "month",
    }
    assert len(result["data"]["series"]) == 12
    assert result["data"]["recommendedGrain"]["grain"] == "month"
    assert any(w["code"] == "LOW_SAMPLE" for w in result["meta"]["warnings"])

    cohorts = cohorts_query(org_data(), now=now)
    assert cohorts["data"]["cohorts"][0]["cohort"] == "2025-04"
    assert len(cohorts["data"]["cohorts"]) == 12


def test_grain_mismatch_is_flagged() -> None:
    result = retention_query(org_data(), grain="quarter", now=datetime(2026, 4, 20, tzinfo=UTC))
    assert result["meta"]["period"]["grain"] == "quarter"
    assert any(w["code"] == "GRAIN_MISMATCH" for w in result["meta"]["warnings"])


def http() -> TestClient:
    return TestClient(
        create_app(
            version="x",
            service_token=TOKEN,
            database=FakeDb(),
            analytics=AnalyticsService(CountingLoader()),
        )
    )


def test_internal_behavior_endpoints() -> None:
    headers = {"X-Service-Token": TOKEN}
    base = {"organizationId": str(ORG), "start": "2026-01-01", "end": "2026-04-01"}
    retention = http().post(
        "/internal/query/retention", json={**base, "grain": "month"}, headers=headers
    )
    assert retention.status_code == 200
    assert [r["retained"] for r in retention.json()["data"]["series"]] == [0, 1, 1]

    churn = http().post(
        "/internal/query/churn", json={**base, "segmentConfig": DEFAULT}, headers=headers
    )
    assert churn.status_code == 200
    assert churn.json()["data"]["churnDays"] == 180

    listed = http().post(
        "/internal/query/churn/customers",
        json={"organizationId": str(ORG), "start": "2025-11-01", "end": "2025-12-01"},
        headers=headers,
    )
    assert [r["customerId"] for r in listed.json()["data"]] == ["E"]

    cohorts = http().post(
        "/internal/query/cohorts",
        json={**base, "maxPeriods": 3, "segment": "loyal"},
        headers=headers,
    )
    body = cohorts.json()
    assert [c["cohort"] for c in body["data"]["cohorts"]] == ["2026-01", "2026-02", "2026-03"]
    assert any(w["code"] == "SEGMENT_FILTER" for w in body["meta"]["warnings"])


def test_internal_behavior_validation() -> None:
    headers = {"X-Service-Token": TOKEN}
    org = {"organizationId": str(ORG)}
    assert http().post("/internal/query/retention", json=org).status_code == 401
    bad_grain = http().post(
        "/internal/query/retention", json={**org, "grain": "day"}, headers=headers
    )
    assert bad_grain.status_code == 422
    too_many = http().post(
        "/internal/query/cohorts", json={**org, "maxPeriods": 99}, headers=headers
    )
    assert too_many.status_code == 422
    bad_config = http().post(
        "/internal/query/churn", json={**org, "segmentConfig": {"rules": "x"}}, headers=headers
    )
    assert bad_config.status_code == 422


def test_planted_churn_wave_shows_in_its_cohort() -> None:
    """End to end on generated data: the churn-wave cohort keeps the fewest customers."""
    from insights.datagen import GeneratorConfig, generate

    end = date(2026, 10, 31)
    generated = generate(GeneratorConfig(customers=4000, seed=3, end_date=end))
    orders = generated.orders[generated.orders["status"].isin(["completed", "partially_refunded"])]
    frame = pd.DataFrame(
        {
            "customer_id": orders["customerExternalId"],
            "day": orders["orderedAt"].dt.tz_convert("UTC").dt.tz_localize(None).dt.normalize(),
            "orders": 1,
            "net": orders["grossCents"] - orders["discountCents"] - orders["refundedCents"],
        }
    )
    wave = generated.ground_truth["churn_wave_cohort"]
    result = cohort_matrix(
        frame, cohort_months(date(2025, 12, 1), date(2026, 7, 1)), 4, date(2026, 11, 15)
    )
    later = {
        c["cohort"]: sum(c["retention"][1:4]) / 3 for c in result["cohorts"] if c["size"] >= 30
    }
    assert wave in later
    assert min(later, key=later.__getitem__) == wave

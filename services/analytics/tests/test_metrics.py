"""Golden tests: every expected value below is worked out by hand from tests/fixtures.py."""

from datetime import date

import pandas as pd
import pytest

from insights.metrics.core import (
    active_customers,
    churn,
    customer_metrics,
    historical_clv,
    lifecycle_counts,
    period_kpis,
    retention,
    total_customers,
    trend,
)
from insights.periods import Period, buckets
from tests.fixtures import SETTINGS, customers, purchases

MARCH = Period(date(2026, 3, 1), date(2026, 4, 1))
END_OF_MARCH = date(2026, 3, 31)


def test_march_kpis() -> None:
    kpis = period_kpis(purchases(), customers(), MARCH, SETTINGS, END_OF_MARCH)
    assert kpis["revenue_net"] == 300 + 120 + 1000  # guests included
    assert kpis["orders"] == 4
    assert kpis["aov"] == pytest.approx(1420 / 4)
    assert kpis["buyers"] == 2  # A and C
    assert kpis["new_customers"] == 0  # A first bought in January, C in December
    assert kpis["returning_customers"] == 2
    assert kpis["purchase_frequency"] == 1.0  # 2 identified orders / 2 buyers
    assert kpis["total_customers"] == 6  # everyone became a customer before April
    assert kpis["active_customers"] == 3  # A (26 days), B (58), C (11); F 136 and E 303 are out
    assert kpis["guest_revenue_share"] == pytest.approx(1000 / 1420)


def test_retention_compares_adjacent_periods() -> None:
    # February buyers: A, B. Of those, A bought again in March.
    r = retention(purchases(), MARCH)
    assert (r.numerator, r.denominator) == (1, 2)
    assert r.value == 0.5
    assert r.low_sample is True


def test_churn_counts_customers_alive_at_the_start() -> None:
    # Alive on 2026-03-01 (last purchase within 180 days): A, B, C, F. Nobody churns in March.
    c = churn(purchases(), MARCH, 180, END_OF_MARCH)
    assert (c.numerator, c.denominator) == (0, 4)


def test_churn_is_recognised_on_the_threshold_date_not_before() -> None:
    november = Period(date(2025, 11, 1), date(2025, 12, 1))
    # E (last purchase 2025-06-01) churns on 2025-11-28.
    assert churn(purchases(), november, 180, date(2025, 11, 30)).numerator == 1
    assert churn(purchases(), november, 180, date(2025, 11, 27)).numerator == 0
    assert churn(purchases(), november, 180, date(2025, 11, 30)).denominator == 1


def test_customer_since_uses_registration_or_first_purchase_not_import_date() -> None:
    c = customers().set_index("customer_id")["since"]
    assert c["A"] == pd.Timestamp("2026-01-10")  # first purchase
    assert c["B"] == pd.Timestamp("2026-01-15")  # registered before buying
    assert c["D"] == pd.Timestamp("2026-02-10")  # prospect: registration
    assert total_customers(customers(), date(2026, 1, 1)) == 3  # C, E, F


def test_active_customers_window_edges() -> None:
    p = purchases()
    # B's last purchase is 2026-02-01: active through 2026-05-02 (90 days), not after.
    assert active_customers(p[p["customer_id"] == "B"], date(2026, 5, 2), 90) == 1
    assert active_customers(p[p["customer_id"] == "B"], date(2026, 5, 3), 90) == 0


def test_historical_clv() -> None:
    clv = historical_clv(purchases(), END_OF_MARCH)
    # A 600, B 50, C 200, E 500, F 40
    assert clv == {"mean": 278.0, "median": 200.0, "customers": 5}


def test_monthly_trend() -> None:
    months = buckets(Period(date(2026, 1, 1), date(2026, 4, 1)), "month")
    rows = trend(purchases(), months)
    assert [r["revenueNet"] for r in rows] == [100, 250, 1420]
    assert [r["newCustomers"] for r in rows] == [1, 1, 0]  # A in Jan, B in Feb
    assert [r["returningCustomers"] for r in rows] == [0, 1, 2]
    assert [r["aov"] for r in rows] == [100, 125, 355]


def test_customer_metrics_snapshot() -> None:
    m = customer_metrics(purchases(), customers(), END_OF_MARCH, SETTINGS).set_index("customer_id")
    a = m.loc["A"]
    assert (a["order_count"], a["total_net"], a["aov"]) == (3, 600, 200)
    assert (a["recency_days"], a["tenure_days"]) == (26, 80)
    assert a["median_gap"] == 27  # gaps of 36 and 18 days
    assert a["frequency_per_month"] == pytest.approx(3 / 80 * 30)
    assert m.loc["A", "lifecycle_status"] == "ACTIVE"
    assert m.loc["D", "lifecycle_status"] == "PROSPECT"
    assert m.loc["D", "order_count"] == 0
    assert m.loc["F", "lifecycle_status"] == "AT_RISK"
    assert m.loc["E", "lifecycle_status"] == "CHURNED"
    assert lifecycle_counts(m.reset_index()) == {
        "PROSPECT": 1,
        "ACTIVE": 3,
        "AT_RISK": 1,
        "CHURNED": 1,
    }


def test_snapshot_ignores_purchases_after_as_of() -> None:
    m = customer_metrics(purchases(), customers(), date(2026, 2, 28), SETTINGS)
    a = m.set_index("customer_id").loc["A"]
    assert (a["order_count"], a["total_net"]) == (2, 300)

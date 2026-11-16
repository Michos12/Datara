import re
from datetime import date

import pandas as pd
import pytest

from insights.datagen import GeneratorConfig, generate
from insights.ids import uuid7
from insights.money import currency_minor_units, to_minor

END = date(2026, 10, 31)


@pytest.fixture(scope="module")
def data():  # type: ignore[no-untyped-def]
    return generate(
        GeneratorConfig(customers=3000, seed=7, end_date=END, timezone="America/Bogota")
    )


def test_is_deterministic_for_a_seed() -> None:
    config = GeneratorConfig(customers=200, seed=11, end_date=END)
    a, b = generate(config), generate(config)
    pd.testing.assert_frame_equal(a.orders, b.orders)
    pd.testing.assert_frame_equal(a.customers, b.customers)
    assert not generate(GeneratorConfig(customers=200, seed=12, end_date=END)).orders.equals(
        a.orders
    )


def test_orders_are_internally_consistent(data) -> None:  # type: ignore[no-untyped-def]
    o = data.orders
    assert o["externalId"].is_unique
    assert (o["grossCents"] > 0).all()
    assert (o["discountCents"] <= o["grossCents"]).all()
    assert (o["refundedCents"] <= o["grossCents"] - o["discountCents"]).all()
    assert set(o["status"]) <= {"completed", "cancelled", "refunded", "partially_refunded"}
    refunded = o[o["status"] == "refunded"]
    assert (refunded["refundedCents"] == refunded["grossCents"] - refunded["discountCents"]).all()
    # The end date is a local calendar date in the organization's time zone.
    assert o["orderedAt"].dt.tz_convert("America/Bogota").max().date() <= END
    assert o["orderedAt"].is_monotonic_increasing


def test_orders_reference_known_customers_or_guests(data) -> None:  # type: ignore[no-untyped-def]
    known = set(data.customers["externalId"])
    referenced = set(data.orders["customerExternalId"].dropna())
    assert referenced <= known
    guest_share = data.orders["customerExternalId"].isna().mean()
    assert 0.03 < guest_share < 0.07
    assert data.ground_truth["guest_orders"] == data.orders["customerExternalId"].isna().sum()


def test_has_realistic_shapes(data) -> None:  # type: ignore[no-untyped-def]
    per_customer = (
        data.orders.dropna(subset=["customerExternalId"]).groupby("customerExternalId").size()
    )
    buyers = len(per_customer)
    # Most customers buy once or twice; some come back often.
    assert (per_customer <= 2).mean() > 0.4
    assert (per_customer >= 5).mean() > 0.05
    # Spend per order is right-skewed (mean above median).
    assert data.orders["grossCents"].mean() > data.orders["grossCents"].median()
    # Prospects registered but never bought.
    assert len(data.customers) - buyers == pytest.approx(data.ground_truth["prospects"], abs=5)


def test_planted_patterns_are_detectable(data) -> None:  # type: ignore[no-untyped-def]
    orders = data.orders.dropna(subset=["customerExternalId"])
    spend = orders.groupby("customerExternalId")["grossCents"].sum()
    vips = set(data.ground_truth["vip_customers"])
    vip_spend = spend[spend.index.isin(vips)].median()
    other_spend = spend[~spend.index.isin(vips)].median()
    assert vip_spend > 3 * other_spend

    customers = data.customers.set_index("externalId")
    cohort = pd.to_datetime(customers["registeredAt"]).dt.strftime("%Y-%m")
    counts = orders.groupby("customerExternalId").size()
    repeat = (counts >= 2).groupby(cohort.reindex(counts.index)).mean()
    wave = data.ground_truth["churn_wave_cohort"]
    neighbours = repeat.drop(wave).loc[lambda s: s.index < wave].tail(4).mean()
    assert repeat[wave] < neighbours * 0.8


def test_amounts_use_iso_minor_units() -> None:
    cop = generate(GeneratorConfig(customers=50, currency="COP", seed=1, end_date=END))
    # COP has 2 ISO minor units: a ~88,000 peso order is ~8,800,000 centavos.
    assert cop.orders["grossCents"].median() > 1_000_000
    assert currency_minor_units("JPY") == 0
    assert currency_minor_units("KWD") == 3
    assert to_minor(12.345, "USD") == 1234 or to_minor(12.345, "USD") == 1235
    assert to_minor(1500, "JPY") == 1500


def test_uuid7_is_time_ordered() -> None:
    a, b = uuid7(1_700_000_000_000), uuid7(1_700_000_000_001)
    assert a.version == 7
    assert str(a) < str(b)
    assert re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-7", str(a))

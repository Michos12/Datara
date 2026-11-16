from datetime import UTC, date, datetime, timedelta

import pandas as pd
from hypothesis import given, settings
from hypothesis import strategies as st

from insights.metrics.core import (
    buyers,
    churn,
    customer_metrics,
    period_kpis,
    retention,
    trend,
)
from insights.periods import Period, add_months, auto_grain, buckets, floor_to_grain, today_in
from insights.settings import PRESETS, resolve_settings
from insights.worker.recompute import next_nightly
from tests.fixtures import SETTINGS


class TestPeriods:
    def test_previous_of_whole_months_is_calendar_aligned(self) -> None:
        march = Period(date(2026, 3, 1), date(2026, 4, 1))
        assert march.previous() == Period(date(2026, 2, 1), date(2026, 3, 1))
        q1 = Period(date(2026, 1, 1), date(2026, 4, 1))
        assert q1.previous() == Period(date(2025, 10, 1), date(2026, 1, 1))

    def test_previous_of_arbitrary_range_has_equal_length(self) -> None:
        week = Period(date(2026, 3, 10), date(2026, 3, 17))
        assert week.previous() == Period(date(2026, 3, 3), date(2026, 3, 10))

    def test_previous_year_handles_leap_day(self) -> None:
        p = Period(date(2028, 2, 29), date(2028, 3, 1))
        assert p.previous_year() == Period(date(2027, 2, 28), date(2027, 3, 1))

    def test_buckets_are_calendar_aligned_and_clipped(self) -> None:
        p = Period(date(2026, 1, 15), date(2026, 3, 10))
        assert [b.to_dict() for b in buckets(p, "month")] == [
            {"start": "2026-01-15", "end": "2026-02-01"},
            {"start": "2026-02-01", "end": "2026-03-01"},
            {"start": "2026-03-01", "end": "2026-03-10"},
        ]

    def test_week_start(self) -> None:
        wednesday = date(2026, 11, 18)
        assert floor_to_grain(wednesday, "week", "monday") == date(2026, 11, 16)
        assert floor_to_grain(wednesday, "week", "sunday") == date(2026, 11, 15)
        assert floor_to_grain(wednesday, "quarter") == date(2026, 10, 1)

    def test_partial_until_the_last_day_is_over(self) -> None:
        march = Period(date(2026, 3, 1), date(2026, 4, 1))
        assert march.is_partial(date(2026, 3, 31))
        assert not march.is_partial(date(2026, 4, 1))

    def test_add_months_clamps_day(self) -> None:
        assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
        assert add_months(date(2026, 1, 15), -13) == date(2024, 12, 15)

    def test_auto_grain(self) -> None:
        assert auto_grain(Period(date(2026, 1, 1), date(2026, 2, 1))) == "day"
        assert auto_grain(Period(date(2026, 1, 1), date(2026, 4, 1))) == "week"
        assert auto_grain(Period(date(2025, 1, 1), date(2026, 1, 1))) == "month"

    def test_local_today_and_nightly_schedule(self) -> None:
        now = datetime(2026, 4, 1, 3, 30, tzinfo=UTC)  # 22:30 on 31 March in Bogotá
        assert today_in("America/Bogota", now) == date(2026, 3, 31)
        assert next_nightly("America/Bogota", now) == datetime(2026, 4, 1, 7, 0, tzinfo=UTC)


class TestSettings:
    def test_invalid_stored_settings_fall_back_to_preset(self) -> None:
        assert resolve_settings("retail", {"churnDays": 30}) == PRESETS["retail"]  # < active window
        assert resolve_settings("retail", "nonsense") == PRESETS["retail"]
        assert resolve_settings("unknown", None) == PRESETS["other"]

    def test_stored_values_override_preset(self) -> None:
        s = resolve_settings("restaurant", {"activeWindowDays": 45, "churnDays": 120})
        assert (s.active_window_days, s.churn_days, s.default_grain) == (45, 120, "week")


# ───────────── property tests: invariants on random data ─────────────

START = date(2025, 1, 1)
purchase_rows = st.lists(
    st.tuples(
        st.one_of(st.none(), st.sampled_from([f"c{i}" for i in range(12)])),
        st.integers(min_value=0, max_value=540),
        st.integers(min_value=1, max_value=3),
        st.integers(min_value=0, max_value=50_000),
    ),
    min_size=1,
    max_size=80,
)


def _frames(rows: list[tuple[str | None, int, int, int]]) -> tuple[pd.DataFrame, pd.DataFrame]:
    df = pd.DataFrame(
        [(c, START + timedelta(days=d), o, n) for c, d, o, n in rows],
        columns=["customer_id", "day", "orders", "net"],
    )
    df["day"] = pd.to_datetime(df["day"])
    df = df.groupby(["customer_id", "day"], dropna=False, as_index=False).sum()
    ids = sorted({c for c in df["customer_id"] if c is not None and not pd.isna(c)})
    first = df.dropna(subset=["customer_id"]).groupby("customer_id")["day"].min()
    customers = pd.DataFrame({"customer_id": ids, "since": [first[i] for i in ids]})
    return df, customers


@settings(max_examples=150, deadline=None)
@given(
    purchase_rows, st.integers(min_value=0, max_value=500), st.integers(min_value=1, max_value=120)
)
def test_invariants(rows: list[tuple[str | None, int, int, int]], offset: int, length: int) -> None:
    p, c = _frames(rows)
    period = Period(START + timedelta(days=offset), START + timedelta(days=offset + length))
    as_of = period.last_day
    k = period_kpis(p, c, period, SETTINGS, as_of)

    assert k["new_customers"] + k["returning_customers"] == k["buyers"]
    assert k["buyers"] == len(buyers(p, period))
    assert k["active_customers"] <= k["total_customers"] <= len(c)
    for ratio in (retention(p, period), churn(p, period, SETTINGS.churn_days, as_of)):
        assert 0 <= ratio.numerator <= ratio.denominator
    if k["orders"]:
        assert k["aov"] == k["revenue_net"] / k["orders"]

    # Trend buckets partition the period exactly.
    rows_ = trend(p, buckets(period, "week"))
    assert sum(r["revenueNet"] for r in rows_) == k["revenue_net"]
    assert sum(r["orders"] for r in rows_) == k["orders"]

    # Every customer gets exactly one lifecycle status; totals match purchases.
    m = customer_metrics(p, c, as_of, SETTINGS)
    assert len(m) == len(c)
    assert set(m["lifecycle_status"]) <= {"PROSPECT", "ACTIVE", "AT_RISK", "CHURNED"}
    identified = p[p["customer_id"].notna() & (p["day"] <= pd.Timestamp(as_of))]
    assert int(m["total_net"].sum()) == int(identified["net"].sum())

"""RFM golden tests. Expected scores are worked out by hand from tests/fixtures.py.

As of 2026-03-31, look-back 365 days, recency cut points 30/90/180/365, frequency minimums
2/3/4/6, monetary by quintile:

    customer  recency  F (orders)  M      R  F  M   segment
    A         26       3           600    5  3  5   loyal
    B         58       1           50     4  1  2   promising
    C         11       2           200    5  2  3   potential_loyalists
    E         303      1           500    2  1  4   hibernating
    F         136      1           40     3  1  1   need_attention
    D         never bought                          None (no purchases)
"""

from datetime import date
from typing import Any

import pandas as pd
import pytest

from insights.metrics.rfm import (
    SegmentConfig,
    assign_segments,
    minimum_threshold_scores,
    quintile_scores,
    recency_threshold_scores,
    rfm,
    rfm_matrix,
    segment_counts,
)
from tests.fixtures import customers, purchases

CUT_POINTS = (30, 90, 180, 365)

DEFAULT: dict[str, Any] = {
    "lookbackDays": 365,
    "scoring": {"recency": "thresholds", "frequency": "thresholds", "monetary": "quintile"},
    "frequencyThresholds": [2, 3, 4, 6],
    "monetaryThresholds": None,
    "rules": [
        {"key": "champions", "r": [4, 5], "f": [4, 5]},
        {"key": "cant_lose_them", "r": [1, 2], "f": [4, 5], "m": [4, 5]},
        {"key": "at_risk", "r": [1, 2], "f": [3, 5]},
        {"key": "loyal", "r": [3, 5], "f": [3, 5]},
        {"key": "potential_loyalists", "r": [4, 5], "f": [2, 2]},
        {"key": "new_customers", "r": [5, 5], "f": [1, 1]},
        {"key": "promising", "r": [4, 4], "f": [1, 1]},
        {"key": "need_attention", "r": [3, 3], "f": [1, 2]},
        {"key": "hibernating", "r": [2, 2], "f": [1, 2]},
        {"key": "lost", "r": [1, 1], "f": [1, 2]},
    ],
}


def run(config: dict[str, Any] = DEFAULT, as_of: date = date(2026, 3, 31)) -> pd.DataFrame:
    return rfm(
        purchases(), customers(), as_of, CUT_POINTS, SegmentConfig.from_dict(config)
    ).set_index("customer_id")


def test_golden_scores_and_segments() -> None:
    r = run()
    expected = {
        "A": (26, 3, 600, 5, 3, 5, "loyal"),
        "B": (58, 1, 50, 4, 1, 2, "promising"),
        "C": (11, 2, 200, 5, 2, 3, "potential_loyalists"),
        "E": (303, 1, 500, 2, 1, 4, "hibernating"),
        "F": (136, 1, 40, 3, 1, 1, "need_attention"),
    }
    for customer, (days, f, m, rs, fs, ms, segment) in expected.items():
        row = r.loc[customer]
        assert (row["recency_days"], row["f_value"], row["m_value"]) == (days, f, m), customer
        assert (row["r_score"], row["f_score"], row["m_score"]) == (rs, fs, ms), customer
        assert row["segment_key"] == segment, customer


def test_customers_without_purchases_are_not_scored() -> None:
    d = run().loc["D"]
    assert pd.isna(d["r_score"])
    assert pd.isna(d["segment_key"])
    assert pd.isna(d["f_value"])


def test_purchases_before_the_window_score_one_and_do_not_skew_quintiles() -> None:
    # 60-day window ending 2026-03-31: E and F bought, but not in the window.
    r = run({**DEFAULT, "lookbackDays": 60})
    for dormant in ("E", "F"):
        row = r.loc[dormant]
        assert (row["f_value"], row["r_score"], row["f_score"], row["m_score"]) == (0, 1, 1, 1)
        assert row["segment_key"] == "lost"
    # Only A (500), B (50) and C (120) are ranked for monetary value.
    assert (r.loc["A", "m_score"], r.loc["B", "m_score"], r.loc["C", "m_score"]) == (5, 2, 4)


def test_quintile_scoring_shares_ranks_between_ties() -> None:
    values = pd.Series([1, 1, 1, 1, 5])
    assert quintile_scores(values).tolist() == [3, 3, 3, 3, 5]
    assert quintile_scores(pd.Series([10, 20, 30, 40, 50])).tolist() == [1, 2, 3, 4, 5]
    assert quintile_scores(pd.Series([], dtype="float64")).empty


def test_threshold_scoring() -> None:
    days = pd.Series([0, 30, 31, 90, 180, 365, 366])
    assert recency_threshold_scores(days, CUT_POINTS).tolist() == [5, 5, 4, 4, 3, 2, 1]
    orders = pd.Series([1, 2, 3, 5, 6, 40])
    assert minimum_threshold_scores(orders, (2, 3, 4, 6)).tolist() == [1, 2, 3, 4, 5, 5]


def test_recency_by_quintile() -> None:
    r = run({**DEFAULT, "scoring": {**DEFAULT["scoring"], "recency": "quintile"}})
    # Most recent (C, 11 days) scores 5; least recent (E, 303 days) scores 1.
    assert r.loc["C", "r_score"] == 5
    assert r.loc["E", "r_score"] == 1


def test_first_matching_rule_wins() -> None:
    scores = pd.DataFrame({"r_score": [1, 1], "f_score": [5, 5], "m_score": [5, 1]})
    config = SegmentConfig.from_dict(DEFAULT)
    assert assign_segments(scores, config.rules).tolist() == ["cant_lose_them", "at_risk"]


def test_matrix_and_counts() -> None:
    segmented = run().reset_index()
    matrix = rfm_matrix(segmented)
    assert sum(map(sum, matrix)) == 5  # D is not scored
    assert matrix[5 - 1][3 - 1] == 1  # A: R5 F3
    assert matrix[2 - 1][1 - 1] == 1  # E: R2 F1
    assert segment_counts(segmented) == {
        "loyal": 1,
        "promising": 1,
        "potential_loyalists": 1,
        "hibernating": 1,
        "need_attention": 1,
    }


@pytest.mark.parametrize("missing", ["lookbackDays", "rules", "scoring"])
def test_config_parsing_rejects_incomplete_json(missing: str) -> None:
    broken = {k: v for k, v in DEFAULT.items() if k != missing}
    with pytest.raises(KeyError):
        SegmentConfig.from_dict(broken)

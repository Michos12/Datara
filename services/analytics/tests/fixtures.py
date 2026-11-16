"""A tiny hand-built dataset whose every metric is worked out by hand in the tests.

Settings: active window 90 days, churn threshold 180 days. Dates are local business dates.

    A  purchases 2026-01-10 (100), 2026-02-15 (200), 2026-03-05 (300)
    B  registered 2026-01-15, purchase 2026-02-01 (50)
    C  purchases 2025-12-20 (80), 2026-03-20 (120)
    D  registered 2026-02-10, never bought (prospect)
    E  purchase 2025-06-01 (500): churns on 2025-11-28 (06-01 + 180 days)
    F  purchase 2025-11-15 (40): at risk on 2026-03-31 (136 days ago)
    guest orders 2026-03-10: 2 orders, 1000 net
"""

from datetime import date
from uuid import UUID

import pandas as pd

from insights.data.loader import OrgData, customer_since
from insights.settings import AnalyticsSettings

SETTINGS = AnalyticsSettings(
    active_window_days=90,
    churn_days=180,
    week_start="monday",
    default_grain="month",
    recency_cut_points=(30, 90, 180, 365),
)

PURCHASES = [
    ("A", "2026-01-10", 1, 100),
    ("A", "2026-02-15", 1, 200),
    ("A", "2026-03-05", 1, 300),
    ("B", "2026-02-01", 1, 50),
    ("C", "2025-12-20", 1, 80),
    ("C", "2026-03-20", 1, 120),
    ("E", "2025-06-01", 1, 500),
    ("F", "2025-11-15", 1, 40),
    (None, "2026-03-10", 2, 1000),
]

CUSTOMERS = [
    # id, created_day (import date), registered_at
    ("A", "2026-04-01", None),
    ("B", "2026-04-01", "2026-01-15"),
    ("C", "2026-04-01", None),
    ("D", "2026-04-01", "2026-02-10"),
    ("E", "2026-04-01", None),
    ("F", "2026-04-01", None),
]


def purchases() -> pd.DataFrame:
    df = pd.DataFrame(PURCHASES, columns=["customer_id", "day", "orders", "net"])
    df["day"] = pd.to_datetime(df["day"])
    return df.astype({"orders": "int64", "net": "int64"})


def customers() -> pd.DataFrame:
    raw = pd.DataFrame(CUSTOMERS, columns=["customer_id", "created_day", "registered_at"])
    raw["created_day"] = pd.to_datetime(raw["created_day"]).dt.date
    raw["registered_at"] = pd.to_datetime(raw["registered_at"]).dt.date
    return customer_since(raw, purchases())


def org_data(data_version: int = 1) -> OrgData:
    return OrgData(
        organization_id=UUID("0193a2b4-0000-7000-8000-000000000001"),
        data_version=data_version,
        timezone="America/Bogota",
        currency="USD",
        settings=SETTINGS,
        purchases=purchases(),
        customers=customers(),
    )


MARCH = (date(2026, 3, 1), date(2026, 4, 1))

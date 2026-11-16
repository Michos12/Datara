"""Metric definition registry.

Every metric the service returns is declared here with a key, a version and its formula,
mirroring docs/05-analytics-methodology.md. A changed formula gets a new version; stored
snapshots and every API response carry the versions they were computed with (NFR-REL-02).
"""

from dataclasses import asdict, dataclass
from typing import Any, Literal

MetricKind = Literal["measured", "estimated", "score"]
MetricUnit = Literal["count", "money", "ratio", "orders_per_customer", "status"]


@dataclass(frozen=True, slots=True)
class MetricDefinition:
    key: str
    name: str
    version: int
    kind: MetricKind
    unit: MetricUnit
    formula: str
    period_rule: str
    description: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


PERIOD = "Orders whose local business date falls in the selected period [start, end)."
AS_OF = "Evaluated at the reference date (the last day of the period)."

DEFINITIONS: tuple[MetricDefinition, ...] = (
    MetricDefinition(
        "total_customers", "Total customers", 1, "measured", "count",
        "Non-deleted customers whose customer-since date is before the period end. "
        "Customer since = earliest of registration date and first purchase "
        "(record creation date if neither exists).",
        "Cumulative up to the end of the period.",
        "Everyone who had become your customer by the end of the period.",
    ),
    MetricDefinition(
        "active_customers", "Active customers", 1, "measured", "count",
        "Customers whose last countable purchase on or before the reference date is within the "
        "active window (settings.activeWindowDays).",
        AS_OF,
        "Customers who bought recently enough to count as active for your business.",
    ),
    MetricDefinition(
        "buyers", "Buyers", 1, "measured", "count",
        "Distinct identified customers with at least one countable order in the period. "
        "Always equals new + returning customers.",
        PERIOD,
        "How many different customers bought in the period.",
    ),
    MetricDefinition(
        "new_customers", "New customers", 1, "measured", "count",
        "Customers whose first countable order ever falls in the period.",
        PERIOD,
        "First-time buyers. Registration without a purchase does not count.",
    ),
    MetricDefinition(
        "returning_customers", "Returning customers", 1, "measured", "count",
        "Buyers in the period whose first countable order was before the period.",
        PERIOD,
        "Buyers who had bought from you before.",
    ),
    MetricDefinition(
        "revenue_net", "Net revenue", 1, "measured", "money",
        "Sum of (gross − discount − refunded) over countable orders, guest orders included. "
        "Tax excluded.",
        PERIOD,
        "Money kept from sales after discounts and refunds.",
    ),
    MetricDefinition(
        "orders", "Orders", 1, "measured", "count",
        "Countable orders (completed or partially refunded, not deleted), guests included.",
        PERIOD,
        "Number of purchases.",
    ),
    MetricDefinition(
        "aov", "Average order value", 1, "measured", "money",
        "Net revenue ÷ orders. Undefined when there are no orders.",
        PERIOD,
        "What a typical order is worth.",
    ),
    MetricDefinition(
        "purchase_frequency", "Purchase frequency", 1, "measured", "orders_per_customer",
        "Orders by identified customers ÷ buyers.",
        PERIOD,
        "How many times each buying customer ordered in the period, on average.",
    ),
    MetricDefinition(
        "retention_rate", "Retention rate", 1, "measured", "ratio",
        "|C(P₋₁) ∩ C(P)| ÷ |C(P₋₁)|: of the customers who bought in the previous period of equal "
        "length, the share who bought again in this period.",
        "Compares the period with the one immediately before it.",
        "Whether last period's buyers came back. Looks low by nature when customers buy "
        "less often than the period length.",
    ),
    MetricDefinition(
        "churn_rate", "Churn rate", 1, "measured", "ratio",
        "Customers alive at the period start (last purchase within the churn threshold) whose "
        "churn date (last purchase + settings.churnDays, with no purchase in between) falls in "
        "the period, ÷ customers alive at the period start.",
        "Churn is recognised only once the threshold has passed, so it lags inactivity.",
        "Customers who crossed your inactivity threshold. This is not 1 − retention rate: "
        "retention compares adjacent periods, churn measures long inactivity.",
    ),
    MetricDefinition(
        "historical_clv", "Historical CLV", 1, "measured", "money",
        "Mean of each customer's total net revenue up to the reference date, over customers "
        "with at least one purchase. The median is reported alongside.",
        AS_OF,
        "What customers have actually spent with you so far. Not a prediction.",
    ),
    MetricDefinition(
        "lifecycle_status", "Lifecycle status", 1, "measured", "status",
        "Prospect: no purchases. Active: recency ≤ active window. At risk: active window < "
        "recency ≤ churn threshold. Churned: recency > churn threshold.",
        AS_OF,
        "Where each customer stands today, from days since their last purchase.",
    ),
)  # fmt: skip

DEFINITION_VERSIONS: dict[str, int] = {d.key: d.version for d in DEFINITIONS}
BY_KEY: dict[str, MetricDefinition] = {d.key: d for d in DEFINITIONS}

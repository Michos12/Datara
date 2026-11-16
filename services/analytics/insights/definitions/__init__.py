"""Metric definition registry.

Every metric the service computes is declared here with a key, a version and its formula,
mirroring docs/05-analytics-methodology.md. A changed formula gets a new version; stored
snapshots keep the version they were computed with. Metrics are registered from M3.
"""

from dataclasses import asdict, dataclass
from typing import Any, Literal

MetricKind = Literal["measured", "estimated", "score"]


@dataclass(frozen=True, slots=True)
class MetricDefinition:
    key: str
    name: str
    version: int
    kind: MetricKind
    formula: str
    period_rule: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


DEFINITIONS: tuple[MetricDefinition, ...] = ()

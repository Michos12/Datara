"""Organization analytics settings with industry presets (mirrors packages/contracts)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from insights.periods import Grain, WeekStart


@dataclass(frozen=True, slots=True)
class AnalyticsSettings:
    active_window_days: int
    churn_days: int
    week_start: WeekStart
    default_grain: Grain
    recency_cut_points: tuple[int, int, int, int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "activeWindowDays": self.active_window_days,
            "churnDays": self.churn_days,
            "weekStart": self.week_start,
            "defaultGrain": self.default_grain,
            "recencyCutPoints": list(self.recency_cut_points),
        }


Industry = Literal["retail", "ecommerce", "restaurant", "subscription", "services", "other"]

PRESETS: dict[str, AnalyticsSettings] = {
    "restaurant": AnalyticsSettings(30, 90, "monday", "week", (14, 30, 60, 90)),
    "retail": AnalyticsSettings(90, 180, "monday", "month", (30, 90, 180, 365)),
    "ecommerce": AnalyticsSettings(90, 180, "monday", "month", (30, 90, 180, 365)),
    "subscription": AnalyticsSettings(45, 90, "monday", "month", (30, 45, 90, 180)),
    "services": AnalyticsSettings(180, 365, "monday", "quarter", (60, 180, 365, 540)),
    "other": AnalyticsSettings(90, 180, "monday", "month", (30, 90, 180, 365)),
}


def resolve_settings(industry: str, stored: Any) -> AnalyticsSettings:
    """Stored settings over the industry preset; invalid values fall back to the preset."""
    preset = PRESETS.get(industry, PRESETS["other"])
    if not isinstance(stored, dict):
        return preset
    try:
        cut = stored.get("recencyCutPoints", list(preset.recency_cut_points))
        settings = AnalyticsSettings(
            active_window_days=int(stored.get("activeWindowDays", preset.active_window_days)),
            churn_days=int(stored.get("churnDays", preset.churn_days)),
            week_start=stored.get("weekStart", preset.week_start),
            default_grain=stored.get("defaultGrain", preset.default_grain),
            recency_cut_points=(int(cut[0]), int(cut[1]), int(cut[2]), int(cut[3])),
        )
    except (TypeError, ValueError, IndexError, KeyError):
        return preset
    if settings.churn_days <= settings.active_window_days or settings.week_start not in (
        "monday",
        "sunday",
    ):
        return preset
    return settings

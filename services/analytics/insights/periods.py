"""Calendar periods in an organization's time zone (docs/05-analytics-methodology.md §2).

Periods are half-open `[start, end)` business dates. All bucketing happens on local dates that
SQL already converted from UTC with the organization's IANA time zone.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

Grain = Literal["day", "week", "month", "quarter"]
WeekStart = Literal["monday", "sunday"]


@dataclass(frozen=True, slots=True)
class Period:
    start: date
    end: date
    """Exclusive."""

    def __post_init__(self) -> None:
        if self.end <= self.start:
            raise ValueError(f"Empty period {self.start}..{self.end}")

    @property
    def days(self) -> int:
        return (self.end - self.start).days

    @property
    def last_day(self) -> date:
        return self.end - timedelta(days=1)

    def previous(self) -> Period:
        """The period of equal length immediately before this one. Whole calendar months map to
        the previous whole months (so March → February, not 31 days back)."""
        if self.start.day == 1 and self.end.day == 1:
            months = _months_between(self.start, self.end)
            return Period(add_months(self.start, -months), self.start)
        return Period(self.start - timedelta(days=self.days), self.start)

    def previous_year(self) -> Period:
        return Period(_minus_year(self.start), _minus_year(self.end))

    def is_partial(self, today: date) -> bool:
        """True until the period's last day is over: today's sales are still coming in."""
        return today < self.end

    def to_dict(self) -> dict[str, str]:
        return {"start": self.start.isoformat(), "end": self.end.isoformat()}


def add_months(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    year, month = divmod(index, 12)
    month += 1
    last = _days_in_month(year, month)
    return date(year, month, min(day.day, last))


def _days_in_month(year: int, month: int) -> int:
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    return (nxt - timedelta(days=1)).day


def _months_between(a: date, b: date) -> int:
    return (b.year - a.year) * 12 + b.month - a.month


def _minus_year(day: date) -> date:
    try:
        return day.replace(year=day.year - 1)
    except ValueError:  # 29 February
        return day.replace(year=day.year - 1, day=28)


def today_in(timezone: str, now: datetime | None = None) -> date:
    moment = now or datetime.now(ZoneInfo("UTC"))
    return moment.astimezone(ZoneInfo(timezone)).date()


def floor_to_grain(day: date, grain: Grain, week_start: WeekStart = "monday") -> date:
    if grain == "day":
        return day
    if grain == "week":
        offset = day.weekday() if week_start == "monday" else (day.weekday() + 1) % 7
        return day - timedelta(days=offset)
    if grain == "month":
        return day.replace(day=1)
    return date(day.year, 3 * ((day.month - 1) // 3) + 1, 1)


def next_bucket(day: date, grain: Grain) -> date:
    if grain == "day":
        return day + timedelta(days=1)
    if grain == "week":
        return day + timedelta(days=7)
    return add_months(day, 1 if grain == "month" else 3)


def buckets(period: Period, grain: Grain, week_start: WeekStart = "monday") -> list[Period]:
    """Calendar-aligned buckets covering `period`, clipped to its bounds."""
    result: list[Period] = []
    cursor = floor_to_grain(period.start, grain, week_start)
    while cursor < period.end:
        nxt = next_bucket(cursor, grain)
        result.append(Period(max(cursor, period.start), min(nxt, period.end)))
        cursor = nxt
    return result


def auto_grain(period: Period) -> Grain:
    """A readable default: about 10–40 points per chart."""
    if period.days <= 45:
        return "day"
    if period.days <= 190:
        return "week"
    if period.days <= 1100:
        return "month"
    return "quarter"

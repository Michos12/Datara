"""Synthetic customer and order generator with known ground truth.

Each customer gets their own purchase rate and dropout probability (a buy-till-you-die style
process), so the data has realistic shapes: most customers buy once or twice, a few buy often,
spend is right-skewed, and customers silently stop buying. Two patterns are planted so that
analytics can later be checked against a known answer:

* a VIP group (about 5%) that buys more often and spends more per order, a quarter of whom
  ("quiet VIPs") stop buying 60–150 days before the end: high-value customers at risk;
* a "churn wave" acquisition cohort whose customers drop out much faster than everyone else;
* interactions that run ahead of purchases: engaged customers visit and click in the days before
  they buy, so the engagement score should correlate with future purchases.

Everything is driven by one seed: the same inputs always produce the same data.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from insights.money import to_minor


@dataclass(frozen=True)
class IndustryProfile:
    mean_gap_days: float
    """Typical days between purchases for an average customer."""
    aov_usd: float
    """Typical order value in USD before currency scaling."""
    dropout_alpha: float
    dropout_beta: float
    """Beta prior for the probability that a purchase is the customer's last."""
    channels: dict[str, float]


PROFILES: dict[str, IndustryProfile] = {
    "restaurant": IndustryProfile(12, 22, 2, 9, {"in_store": 0.7, "delivery": 0.25, "phone": 0.05}),
    "retail": IndustryProfile(40, 55, 2, 6, {"in_store": 0.6, "online": 0.4}),
    "ecommerce": IndustryProfile(55, 70, 2, 5, {"online": 0.9, "marketplace": 0.1}),
    "subscription": IndustryProfile(30, 35, 1, 12, {"online": 1.0}),
    "services": IndustryProfile(110, 180, 2, 7, {"in_store": 0.5, "phone": 0.3, "online": 0.2}),
    "other": IndustryProfile(45, 60, 2, 6, {"online": 0.5, "in_store": 0.5}),
}

# Rough purchasing-power scale so amounts look plausible in each currency (synthetic data only).
CURRENCY_SCALE: dict[str, float] = {
    "USD": 1, "EUR": 0.92, "GBP": 0.79, "CAD": 1.36, "AUD": 1.52, "MXN": 18, "COP": 4000,
    "CLP": 930, "ARS": 1000, "PEN": 3.7, "BRL": 5.2, "JPY": 150, "INR": 83, "CHF": 0.88,
}  # fmt: skip

COUNTRY_BY_CURRENCY = {"USD": "US", "COP": "CO", "MXN": "MX", "EUR": "ES", "GBP": "GB", "CLP": "CL",
                       "ARS": "AR", "PEN": "PE", "BRL": "BR", "CAD": "CA"}  # fmt: skip
CITIES = {
    "US": ["Austin", "Denver", "Portland", "Chicago", "Miami"],
    "CO": ["Bogotá", "Medellín", "Cali", "Barranquilla", "Bucaramanga"],
    "MX": ["Ciudad de México", "Guadalajara", "Monterrey", "Puebla"],
    "ES": ["Madrid", "Barcelona", "Valencia", "Sevilla"],
}
FIRST_NAMES = ["Ana", "Luis", "María", "Carlos", "Sofía", "Jorge", "Lucía", "Mateo", "Valentina",
               "Andrés", "Camila", "Diego", "Emma", "Liam", "Olivia", "Noah", "Ava", "Elena",
               "Pablo", "Laura", "Daniel", "Sara", "Tomás", "Isabel"]  # fmt: skip
LAST_NAMES = ["García", "Rodríguez", "Martínez", "López", "Gómez", "Pérez", "Smith", "Johnson",
              "Brown", "Torres", "Ramírez", "Flores", "Rivera", "Morales", "Ortiz", "Castro",
              "Vargas", "Rojas", "Herrera", "Medina"]  # fmt: skip

STATUS_WEIGHTS = {
    "completed": 0.92,
    "cancelled": 0.03,
    "refunded": 0.03,
    "partially_refunded": 0.02,
}


@dataclass
class GeneratedData:
    customers: pd.DataFrame
    orders: pd.DataFrame
    interactions: pd.DataFrame = field(default_factory=pd.DataFrame)
    ground_truth: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class GeneratorConfig:
    customers: int = 2000
    months: int = 24
    industry: str = "retail"
    currency: str = "USD"
    timezone: str = "UTC"
    seed: int = 42
    end_date: date | None = None
    """Last day with data (defaults to yesterday). Nothing is generated after it."""
    vip_share: float = 0.05
    prospect_share: float = 0.08
    """Customers who registered but never bought."""
    guest_order_share: float = 0.05
    churn_wave_months_ago: int = 8
    interactions: bool = True
    quiet_vip_share: float = 0.25


def generate(config: GeneratorConfig) -> GeneratedData:
    rng = np.random.default_rng(config.seed)
    profile = PROFILES.get(config.industry, PROFILES["other"])
    tz = ZoneInfo(config.timezone)
    end = config.end_date or (datetime.now(tz).date() - timedelta(days=1))
    start = _add_months(end.replace(day=1), -config.months + 1)
    span_days = (end - start).days + 1
    scale = CURRENCY_SCALE.get(config.currency, 1.0)
    country = COUNTRY_BY_CURRENCY.get(config.currency)

    churn_wave_start = _add_months(end.replace(day=1), -config.churn_wave_months_ago)
    churn_wave_end = _add_months(churn_wave_start, 1)

    # Acquisition grows over time (weight 1 → 2.5 across the window) with mild seasonality.
    day_index = np.arange(span_days)
    weights = 1 + 1.5 * day_index / span_days
    weights *= 1 + 0.15 * np.sin(2 * np.pi * day_index / 365.25)
    acquisition_days = np.sort(
        rng.choice(span_days, size=config.customers, p=weights / weights.sum())
    )

    n = config.customers
    is_vip = rng.random(n) < config.vip_share
    is_prospect = (rng.random(n) < config.prospect_share) & ~is_vip
    mean_gap = profile.mean_gap_days * rng.gamma(shape=2.0, scale=0.5, size=n)
    mean_gap[is_vip] *= 0.5
    dropout = rng.beta(profile.dropout_alpha, profile.dropout_beta, size=n)
    aov = profile.aov_usd * scale * rng.lognormal(mean=0, sigma=0.35, size=n)
    aov[is_vip] *= 2.5

    acquired = [start + timedelta(days=int(d)) for d in acquisition_days]
    in_wave = np.array([churn_wave_start <= a < churn_wave_end for a in acquired])
    dropout[in_wave] = np.clip(dropout[in_wave] * 3 + 0.25, 0, 0.95)

    customer_rows: list[dict[str, Any]] = []
    order_rows: list[dict[str, Any]] = []
    channels = list(profile.channels)
    channel_p = np.array(list(profile.channels.values()))
    statuses = list(STATUS_WEIGHTS)
    status_p = np.array(list(STATUS_WEIGHTS.values()))

    # Interactions draw from their own stream so customers and orders stay identical per seed.
    irng = np.random.default_rng([config.seed, 1])
    engagement = irng.beta(2, 5, size=n)
    engagement[is_vip] = np.clip(engagement[is_vip] * 1.6, 0, 0.95)
    interaction_rows: list[dict[str, Any]] = []

    for i in range(n):
        external_id = f"C-{i + 1:06d}"
        first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
        tags = ["vip"] if is_vip[i] else []
        if rng.random() < 0.4:
            tags.append("newsletter")
        customer_rows.append(
            {
                "externalId": external_id,
                "firstName": str(first),
                "lastName": str(last),
                "email": f"{_ascii(first)}.{_ascii(last)}.{i + 1}@example.com".lower(),
                "phone": None,
                "country": country,
                "city": str(rng.choice(CITIES[country])) if country in CITIES else None,
                "registeredAt": acquired[i].isoformat(),
                "tags": tags,
                "marketingConsent": bool(rng.random() < 0.6),
            }
        )
        if is_prospect[i]:
            continue

        day = acquired[i]
        purchase_days: list[date] = []
        while day <= end:
            order_rows.append(
                _order(rng, day, external_id, aov[i], tz, config.currency, channels, channel_p,
                       statuses, status_p)
            )  # fmt: skip
            purchase_days.append(day)
            if rng.random() < dropout[i]:
                break
            day += timedelta(days=max(1, round(rng.exponential(mean_gap[i]))))
        if config.interactions:
            interaction_rows += _interactions(
                irng, external_id, purchase_days, acquired[i], end, float(engagement[i]),
                bool(customer_rows[-1]["marketingConsent"]), tz,
            )  # fmt: skip

    # Quiet VIPs: steady buyers until 60–150 days before the end, then nothing. Drawn from their
    # own random stream, so every other customer's orders stay the same.
    qrng = np.random.default_rng([config.seed, 2])
    quiet: list[str] = []
    for i in (int(v) for v in np.flatnonzero(is_vip)):
        if is_prospect[i] or qrng.random() >= config.quiet_vip_share:
            continue
        cutoff = end - timedelta(days=int(qrng.integers(60, 151)))
        days: list[date] = []
        day = acquired[i]
        while day < cutoff:
            days.append(day)
            day += timedelta(days=max(1, round(qrng.exponential(mean_gap[i]))))
        if len(days) < 3:
            continue
        external_id = f"C-{i + 1:06d}"
        order_rows = [o for o in order_rows if o["customerExternalId"] != external_id]
        order_rows += [
            _order(qrng, d, external_id, aov[i], tz, config.currency, channels, channel_p,
                   ["completed"], np.array([1.0]))
            for d in days
        ]  # fmt: skip
        quiet.append(external_id)

    # Guest checkouts: revenue without a known customer.
    guests = int(len(order_rows) * config.guest_order_share)
    for _ in range(guests):
        day = start + timedelta(days=int(rng.integers(0, span_days)))
        order_rows.append(
            _order(rng, day, None, profile.aov_usd * scale, tz, config.currency, channels,
                   channel_p, statuses, status_p)
        )  # fmt: skip

    orders = pd.DataFrame(order_rows).sort_values("orderedAt", kind="stable").reset_index(drop=True)
    orders.insert(0, "externalId", [f"O-{i + 1:07d}" for i in range(len(orders))])
    customers = pd.DataFrame(customer_rows)
    interactions = pd.DataFrame(
        interaction_rows,
        columns=["externalId", "customerExternalId", "type", "channel", "occurredAt"],
    )
    if not interactions.empty:
        interactions = interactions.sort_values("occurredAt", kind="stable").reset_index(drop=True)
        interactions["externalId"] = [f"I-{i + 1:07d}" for i in range(len(interactions))]

    ground_truth = {
        "seed": config.seed,
        "industry": config.industry,
        "currency": config.currency,
        "timezone": config.timezone,
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "customers": n,
        "prospects": int(is_prospect.sum()),
        "orders": len(orders),
        "guest_orders": guests,
        "vip_customers": [f"C-{i + 1:06d}" for i in np.flatnonzero(is_vip)],
        "quiet_vip_customers": quiet,
        "churn_wave_cohort": churn_wave_start.strftime("%Y-%m"),
        "churn_wave_customers": int(in_wave.sum()),
        "interactions": len(interactions),
        "notes": "VIPs buy ~2x as often and spend ~2.5x per order; the churn-wave cohort "
        "drops out ~3x faster than other cohorts. Website visits and email clicks precede "
        "purchases for engaged customers.",
    }
    return GeneratedData(
        customers=customers, orders=orders, interactions=interactions, ground_truth=ground_truth
    )


def _interactions(
    rng: np.random.Generator,
    customer: str,
    purchase_days: list[date],
    acquired: date,
    end: date,
    propensity: float,
    consent: bool,
    tz: ZoneInfo,
) -> list[dict[str, Any]]:
    """Touches before purchases (visits, email clicks), a monthly newsletter for consenting
    customers while they are around, and the odd review, ticket or loyalty sign-up."""
    rows: list[dict[str, Any]] = []

    def add(day: date, kind: str, channel: str) -> None:
        if acquired - timedelta(days=30) <= day <= end:
            rows.append({"externalId": "", "customerExternalId": customer, "type": kind,
                         "channel": channel, "occurredAt": _at(rng, day, tz)})  # fmt: skip

    for day in purchase_days:
        if rng.random() < propensity:
            add(day - timedelta(days=int(rng.integers(0, 8))), "WEBSITE_VISIT", "web")
        if rng.random() < propensity * 0.6:
            touch = day - timedelta(days=int(rng.integers(1, 11)))
            add(touch, "EMAIL_OPENED", "email")
            add(touch, "EMAIL_CLICKED", "email")
        if rng.random() < 0.05:
            add(day + timedelta(days=int(rng.integers(2, 15))), "REVIEW", "web")
        if rng.random() < 0.03:
            add(day + timedelta(days=int(rng.integers(1, 20))), "SUPPORT_TICKET", "phone")
    if len(purchase_days) >= 2 and rng.random() < 0.1:
        add(purchase_days[1], "LOYALTY_SIGNUP", "in_store")
    if consent and purchase_days:
        until = min(end, purchase_days[-1] + timedelta(days=120))
        day = acquired + timedelta(days=int(rng.integers(1, 30)))
        while day <= until:
            add(day, "EMAIL_SENT", "email")
            if rng.random() < propensity:
                add(day + timedelta(days=int(rng.integers(0, 3))), "EMAIL_OPENED", "email")
            day += timedelta(days=30)
    return rows


def _at(rng: np.random.Generator, day: date, tz: ZoneInfo) -> datetime:
    local = datetime(day.year, day.month, day.day, tzinfo=tz) + timedelta(
        minutes=int(rng.integers(8 * 60, 22 * 60))
    )
    return local.astimezone(ZoneInfo("UTC"))


def _order(
    rng: np.random.Generator,
    day: date,
    customer: str | None,
    aov: float,
    tz: ZoneInfo,
    currency: str,
    channels: list[str],
    channel_p: np.ndarray,
    statuses: list[str],
    status_p: np.ndarray,
) -> dict[str, Any]:
    local = datetime(day.year, day.month, day.day, tzinfo=tz) + timedelta(
        minutes=int(rng.integers(9 * 60, 21 * 60))
    )
    gross = max(to_minor(float(rng.lognormal(np.log(aov), 0.45)), currency), 1)
    discount = int(gross * rng.uniform(0.05, 0.2)) if rng.random() < 0.2 else 0
    paid = gross - discount
    status = str(rng.choice(statuses, p=status_p))
    refunded = paid if status == "refunded" else (
        int(paid * rng.uniform(0.1, 0.5)) if status == "partially_refunded" else 0
    )  # fmt: skip
    return {
        "customerExternalId": customer,
        "orderedAt": local.astimezone(ZoneInfo("UTC")),
        "status": status,
        "channel": str(rng.choice(channels, p=channel_p)),
        "grossCents": gross,
        "discountCents": discount,
        "taxCents": int(paid * 0.1),
        "refundedCents": refunded,
    }


def _add_months(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def _ascii(text: str) -> str:
    import unicodedata

    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()

"""Generate demo data as import-ready CSV files.

    python -m insights.datagen --customers 2000 --industry retail --currency USD \
        --timezone America/Bogota --seed 42 --out ./demo-data

Writes customers.csv, orders.csv and interactions.csv (headers match the API import templates,
so the files can be uploaded through the import wizard) plus ground_truth.json describing the
planted patterns.
"""

import argparse
import json
from pathlib import Path

from insights.datagen.model import PROFILES, GeneratorConfig, generate
from insights.money import currency_minor_units


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--customers", type=int, default=2000)
    parser.add_argument("--months", type=int, default=24)
    parser.add_argument("--industry", choices=sorted(PROFILES), default="retail")
    parser.add_argument("--currency", default="USD")
    parser.add_argument("--timezone", default="UTC")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=Path, default=Path("demo-data"))
    args = parser.parse_args()

    data = generate(
        GeneratorConfig(
            customers=args.customers,
            months=args.months,
            industry=args.industry,
            currency=args.currency.upper(),
            timezone=args.timezone,
            seed=args.seed,
        )
    )
    args.out.mkdir(parents=True, exist_ok=True)

    customers = data.customers.copy()
    customers["tags"] = customers["tags"].map("|".join)
    customers["marketingConsent"] = customers["marketingConsent"].map({True: "yes", False: "no"})
    customers.to_csv(args.out / "customers.csv", index=False, encoding="utf-8")

    digits = currency_minor_units(args.currency.upper())
    orders = data.orders.copy()
    orders["orderedAt"] = orders["orderedAt"].map(lambda t: t.isoformat().replace("+00:00", "Z"))
    for src, dst in [("grossCents", "grossAmount"), ("discountCents", "discountAmount"),
                     ("taxCents", "taxAmount"), ("refundedCents", "refundedAmount")]:  # fmt: skip
        orders[dst] = orders.pop(src).map(lambda v: f"{v / 10**digits:.{digits}f}")
    orders.to_csv(args.out / "orders.csv", index=False, encoding="utf-8")

    interactions = data.interactions.copy()
    interactions["occurredAt"] = interactions["occurredAt"].map(
        lambda t: t.isoformat().replace("+00:00", "Z")
    )
    interactions.to_csv(args.out / "interactions.csv", index=False, encoding="utf-8")

    (args.out / "ground_truth.json").write_text(json.dumps(data.ground_truth, indent=2), "utf-8")
    print(
        f"Wrote {len(customers)} customers, {len(orders)} orders and {len(interactions)} "
        f"interactions to {args.out.resolve()}"
    )


if __name__ == "__main__":
    main()

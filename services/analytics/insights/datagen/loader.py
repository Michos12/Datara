"""Writes generated data into an organization, inside its row-level-security context."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg

from insights.datagen.model import GeneratedData
from insights.ids import uuid7

BATCH = 1000

INSERT_CUSTOMER = """
INSERT INTO customers (id, organization_id, external_id, first_name, last_name, email, phone,
                       country, city, registered_at, tags, marketing_consent, updated_at)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
"""

INSERT_ORDER = """
INSERT INTO orders (id, organization_id, external_id, customer_id, ordered_at, status, channel,
                    gross_cents, discount_cents, tax_cents, refunded_cents, updated_at)
VALUES (%s, %s, %s, %s, %s, %s::"OrderStatus", %s, %s, %s, %s, %s, now())
"""


class OrganizationNotEmptyError(Exception):
    pass


def load(conn: psycopg.Connection, organization_id: UUID, data: GeneratedData) -> dict[str, int]:
    """Inserts customers and orders. `conn` must be inside `Database.tenant_transaction`."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT (SELECT count(*) FROM customers) + (SELECT count(*) FROM orders)",
        )
        row = cur.fetchone()
        if row and row[0] > 0:
            raise OrganizationNotEmptyError("Organization already has data")

        ids: dict[str, UUID] = {}
        customer_params: list[tuple[Any, ...]] = []
        for c in data.customers.to_dict("records"):
            external_id = str(c["externalId"])
            ids[external_id] = uuid7()
            customer_params.append(
                (ids[external_id], organization_id, external_id, c["firstName"], c["lastName"],
                 c["email"], c["phone"], c["country"], c["city"], c["registeredAt"],
                 list(c["tags"]), bool(c["marketingConsent"]))
            )  # fmt: skip
        for start in range(0, len(customer_params), BATCH):
            cur.executemany(INSERT_CUSTOMER, customer_params[start : start + BATCH])

        order_params: list[tuple[Any, ...]] = []
        for o in data.orders.to_dict("records"):
            customer = o["customerExternalId"]
            ordered_at = o["orderedAt"]
            order_params.append(
                (uuid7(), organization_id, o["externalId"],
                 ids.get(customer) if isinstance(customer, str) else None,
                 ordered_at.to_pydatetime() if hasattr(ordered_at, "to_pydatetime") else ordered_at,
                 str(o["status"]).upper(), o["channel"], int(o["grossCents"]),
                 int(o["discountCents"]), int(o["taxCents"]), int(o["refundedCents"]))
            )  # fmt: skip
        for start in range(0, len(order_params), BATCH):
            cur.executemany(INSERT_ORDER, order_params[start : start + BATCH])

        cur.execute(
            "UPDATE organizations SET data_version = data_version + 1 WHERE id = %s",
            (organization_id,),
        )
    return {"customers": len(customer_params), "orders": len(order_params)}

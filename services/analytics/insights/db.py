"""PostgreSQL access. Prisma owns the schema (ADR-0005); this service uses plain SQL."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Protocol
from uuid import UUID

import psycopg
from psycopg_pool import ConnectionPool


class HealthProbe(Protocol):
    def ping(self) -> bool: ...


class Database:
    """Connection pool wrapper. Tenant data must be accessed through `tenant_transaction`."""

    def __init__(self, url: str, *, max_size: int = 5) -> None:
        self._pool = ConnectionPool(
            url, min_size=1, max_size=max_size, open=False, kwargs={"autocommit": False}
        )

    def open(self) -> None:
        self._pool.open(wait=False)

    def close(self) -> None:
        self._pool.close()

    def ping(self) -> bool:
        try:
            with self._pool.connection(timeout=2) as conn:
                conn.execute("SELECT 1")
            return True
        except (psycopg.Error, TimeoutError):
            return False

    @contextmanager
    def connection(self) -> Iterator[psycopg.Connection]:
        """A pooled connection with no tenant context (job queue only: `jobs` has no RLS)."""
        with self._pool.connection() as conn:
            yield conn

    @contextmanager
    def tenant_transaction(self, organization_id: UUID) -> Iterator[psycopg.Connection]:
        """A transaction scoped to one organization for row-level security (ADR-0004).

        `set_config(..., true)` is transaction-local, so the tenant never leaks to the next
        user of the pooled connection.
        """
        with self._pool.connection() as conn, conn.transaction():
            conn.execute("SELECT set_config('app.org_id', %s, true)", (str(organization_id),))
            yield conn

# ADR-0003: PostgreSQL as the job queue

- **Status:** Accepted (2026-11-16)

## Context

Imports, analytics recomputes and report generation must run in the background, survive
restarts and retry on failure. Expected volume is low (tens of jobs per tenant per day).

## Decision

A `jobs` table. Workers claim with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED
LIMIT 1)`. The Node worker takes `import.*`, `export.*` and `report.*`; the Python worker takes
`analytics.*`. Both implement the same protocol: exponential backoff (30 s × 4ⁿ, capped at
1 h), at most `max_attempts`, and reclaiming locks older than 15 minutes. A partial unique
index allows only one pending `analytics.recompute` per organization.

## Consequences

- No Redis or broker to run; enqueueing can share a transaction with the data change.
- Polling adds up to ~1 s latency; fine for background work.
- The protocol is implemented twice (TypeScript and Python) and must stay consistent; both
  have tests for the backoff schedule.
- Revisit if throughput approaches ~50 jobs/s.

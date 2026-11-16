# ADR-0002: Analytics in a Python service, not in the Node API

- **Status:** Accepted (2026-11-16)

## Context

The specification requires Python, Pandas and NumPy for analytics, and requires analytical
calculations to be separated from business and presentation logic.

## Decision

All metric definitions and calculations live in `services/analytics`. It exposes an internal
FastAPI app (`/internal/*`, service-token protected, never public) for on-demand queries and
runs a worker for batch recomputes. Metric functions are pure (DataFrames + params in,
results out); I/O lives in `insights/data` and the worker handlers. The Node API's
`analytics` module is a facade that never contains metric math.

## Consequences

- The process boundary enforces the separation; it cannot erode through convenience imports.
- Two runtimes to build, test and deploy; the internal API is a contract to keep in sync.
- Metrics are testable with small fixtures and no database.

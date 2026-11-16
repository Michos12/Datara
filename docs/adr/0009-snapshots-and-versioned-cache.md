# ADR-0009: Precomputed snapshots plus a data-versioned query cache

- **Status:** Accepted (2026-11-16). Implemented from M3.

## Context

Dashboards must load in under 500 ms, yet users also filter by arbitrary date ranges and
segments. Analytics must be reproducible (NFR-REL-01).

## Decision

Batch runs write snapshots (`analytics_runs` and child tables) with the definition versions and
the organization's `data_version` they were computed from. Ad-hoc queries go to the Python
service and are cached in `analytics_query_cache`, keyed by
`(organization, metric, params hash, data_version)`. Every tenant data change increments
`organizations.data_version`, so stale cache entries are simply never matched.

## Consequences

- Fast dashboards and exact cache invalidation without a separate cache server.
- Snapshot data can lag a data change by up to ~15 minutes; the UI shows when each result was
  computed.
- Snapshot storage grows over time; a retention job prunes old runs (M9).

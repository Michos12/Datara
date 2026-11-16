# ADR-0001: Modular monolith with a separate analytics process

- **Status:** Accepted (2026-11-16)

## Context

The specification asks for a modular monolith first, with frontend, backend, database and
analytics as separate layers. One developer builds it; operating many services would cost
more than it returns.

## Decision

Two backend deployables: the Node API (one codebase, with API and worker entry points) and the
Python analytics service (HTTP and worker entry points). Inside the API, code is split into
modules (`src/modules/*`) that own routes, schemas, services and repositories, and talk to
each other only through service interfaces.

## Consequences

- Simple deployment and debugging; one database and one migration history.
- Module boundaries are a convention plus lint rules, not network boundaries. Reviews must
  guard them.
- A module can later be extracted if it needs independent scaling (see
  [07-challenges-and-decisions.md](../07-challenges-and-decisions.md) §3).

# ADR-0008: Monorepo with npm workspaces

- **Status:** Accepted (2026-11-16). Supersedes the pnpm mention in
  [02-architecture.md](../02-architecture.md) §2.

## Context

The web app, the API and the shared contracts need to evolve together. The architecture draft
proposed pnpm workspaces, but pnpm is not installed on the development machine, and npm
workspaces cover what this repository needs.

## Decision

A single repository. JavaScript packages (`apps/api`, `apps/web`, `packages/contracts`) are npm
workspaces with one root lockfile. The Python service (`services/analytics`) is managed
separately with uv and its own `uv.lock`. One CI workflow covers both.

## Consequences

- No extra global tooling; `npm ci` is the only install step for JavaScript.
- npm hoists dependencies; phantom dependencies are possible, so each workspace declares every
  package it imports.
- Switching to pnpm later is mechanical if install speed or stricter isolation becomes worth it.

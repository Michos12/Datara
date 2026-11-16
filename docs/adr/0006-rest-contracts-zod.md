# ADR-0006: REST API with shared Zod contracts

- **Status:** Accepted (2026-11-16)

## Context

The specification requires RESTful APIs. The frontend and backend are both TypeScript; API
documentation drifts when it is written separately from the code.

## Decision

`packages/contracts` holds Zod schemas for requests, responses and errors. The API validates
input with them, the web app types and validates responses with them, and (from M1) the
OpenAPI 3.1 document is generated from them. Errors use RFC 9457 problem details with a stable
`code`. The internal Python API mirrors its small contract with Pydantic.

## Consequences

- One definition of each payload; contract changes fail typecheck on both sides.
- The contracts package ships TypeScript source; the API bundle inlines it (tsup `noExternal`)
  and Vite compiles it for the web app.

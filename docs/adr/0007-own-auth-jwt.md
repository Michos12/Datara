# ADR-0007: Own email/password auth with JWT and rotating refresh tokens

- **Status:** Accepted (2026-11-16). Implemented in M1.

## Context

The project is a portfolio piece with production-grade foundations (SRS §9.1). Email and
password is enough at launch; SSO is deferred.

## Decision

Argon2id password hashes. A 15-minute JWT access token (kept in memory by the SPA) carries the
user, active organization and role. A random, opaque refresh token in an `httpOnly; Secure;
SameSite=Strict` cookie is stored hashed, rotated on every use, and grouped in a family;
reusing a rotated token revokes the whole family. The refresh endpoint requires a
double-submit CSRF token. Login is rate-limited per IP and per account.

## Consequences

- No vendor dependency; full control and transparency.
- Security of the auth flow is our responsibility, covered by dedicated tests (rotation, reuse,
  expiry, rate limits).
- Revisit with an identity provider if SSO becomes a requirement.

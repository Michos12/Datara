# ADR-0011: Money in ISO 4217 minor units, one table shared by all code

- **Status:** Accepted (2026-11-16)

## Context

Money is stored as integer minor units (docs/03-data-model.md §1). While building the CSV import,
`Intl.NumberFormat` turned out to report 0 fraction digits for COP, HUF and IDR. Those are
CLDR display conventions, and they can change between ICU versions. ISO 4217 gives those
currencies 2 minor units. If the API used one definition and the Python service another, the same
stored number would mean amounts 100× apart.

## Decision

ISO 4217 defines a minor unit. One table (`currencyMinorUnits` in `packages/contracts`, mirrored
in `services/analytics/insights/money.py`) is used by:

- the API, when parsing imported amounts;
- the web app, when converting between stored values and typed or displayed amounts;
- the Python service, when generating or analysing data.

`Intl` is used only to display the result, with its own rounding. COP is therefore stored in
centavos and displayed in whole pesos.

## Consequences

- One stored value means the same amount everywhere, independent of ICU or CLDR versions.
- The two copies of the table (TypeScript and Python) must stay identical. Both have unit tests on
  the same currencies (USD 2, JPY 0, KWD 3, COP 2).

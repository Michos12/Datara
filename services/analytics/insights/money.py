"""Money conventions shared with the API (packages/contracts/src/organization.ts).

Amounts are stored as integer minor units of the organization currency; ISO 4217 defines how
many minor units a currency has. Keep this table identical to `currencyMinorUnits` in contracts.
"""

ZERO_DECIMAL = frozenset(
    {
        "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI",
        "VND", "VUV", "XAF", "XOF", "XPF",
    }
)  # fmt: skip
THREE_DECIMAL = frozenset({"BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"})


def currency_minor_units(currency: str) -> int:
    if currency in ZERO_DECIMAL:
        return 0
    if currency in THREE_DECIMAL:
        return 3
    return 2


def to_minor(amount: float, currency: str) -> int:
    """Major units (e.g. 12.5 USD) to integer minor units (1250), rounded half to even."""
    factor: int = 10 ** currency_minor_units(currency)
    return round(amount * factor)

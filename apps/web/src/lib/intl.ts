/** Locale data from the browser's Intl implementation (no bundled lists to keep up to date). */

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function timezoneOptions(): { value: string; label: string }[] {
  const zones = Intl.supportedValuesOf('timeZone');
  const list = zones.includes('UTC') ? zones : ['UTC', ...zones];
  return list.map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') }));
}

/** Best guess of the user's currency from their locale region, falling back to USD. */
export function guessCurrency(locale = navigator.language): string {
  const region = new Intl.Locale(locale).maximize().region;
  const byRegion: Record<string, string> = {
    US: 'USD',
    CA: 'CAD',
    MX: 'MXN',
    CO: 'COP',
    AR: 'ARS',
    CL: 'CLP',
    PE: 'PEN',
    BR: 'BRL',
    GB: 'GBP',
    ES: 'EUR',
    FR: 'EUR',
    DE: 'EUR',
    IT: 'EUR',
    PT: 'EUR',
    NL: 'EUR',
    IE: 'EUR',
    AU: 'AUD',
    NZ: 'NZD',
    JP: 'JPY',
    IN: 'INR',
    CH: 'CHF',
    SE: 'SEK',
    NO: 'NOK',
    DK: 'DKK',
  };
  return (region && byRegion[region]) || 'USD';
}

export function currencyOptions(locale = navigator.language): { value: string; label: string }[] {
  const names = new Intl.DisplayNames([locale], { type: 'currency' });
  return Intl.supportedValuesOf('currency').map((code) => ({
    value: code,
    label: `${code} — ${names.of(code) ?? code}`,
  }));
}

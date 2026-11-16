/**
 * Client-side CSV for chart data (ANA-08). Cells that a spreadsheet would run as a formula are
 * prefixed with an apostrophe, like the server's customer export (CSV injection).
 */

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function downloadCsv(filename: string, header: string[], rows: CsvCell[][]): void {
  // A byte-order mark so spreadsheet apps read UTF-8 names correctly.
  const blob = new Blob([String.fromCharCode(0xfeff), toCsv(header, rows)], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

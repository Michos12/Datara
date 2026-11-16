import type { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { detectDelimiter } from './parsing.js';

export interface CsvRecord {
  /** 1-based line number of the record in the file (the header is line 1). */
  line: number;
  values: Record<string, string>;
}

const MAX_COLUMNS = 100;
const BOM_PREFIX = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/** Reads the first chunk of a stream to sniff the delimiter from the header line. */
async function sniff(stream: Readable): Promise<{ delimiter: string; head: Buffer }> {
  for await (const chunk of stream) {
    const head = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    const text = head.toString('utf8').replace(BOM_PREFIX, '');
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    stream.destroy();
    return { delimiter: detectDelimiter(firstLine), head };
  }
  return { delimiter: ',', head: Buffer.alloc(0) };
}

/** Header columns, delimiter and the first `sampleSize` rows. */
export async function inspectCsv(
  open: () => Readable,
  sampleSize = 5,
): Promise<{ delimiter: string; columns: string[]; sample: Record<string, string>[] }> {
  const { delimiter } = await sniff(open());
  let columns: string[] = [];
  const sample: Record<string, string>[] = [];
  for await (const record of readCsv(open(), delimiter, (header) => (columns = header))) {
    sample.push(record.values);
    if (sample.length >= sampleSize) break;
  }
  return { delimiter, columns, sample };
}

export async function detectCsvDelimiter(open: () => Readable): Promise<string> {
  return (await sniff(open())).delimiter;
}

/**
 * Streams records as { line, values } keyed by header. Tolerates BOMs, CRLF, quoted fields,
 * blank lines and short rows; rejects duplicate or empty header names.
 */
export async function* readCsv(
  stream: Readable,
  delimiter: string,
  onHeader?: (columns: string[]) => void,
): AsyncGenerator<CsvRecord> {
  const parser = stream.pipe(
    parse({
      delimiter,
      bom: true,
      columns: (header: string[]) => {
        const columns = header.map((h) => h.trim());
        if (columns.length > MAX_COLUMNS) throw new Error(`Too many columns (max ${MAX_COLUMNS})`);
        const seen = new Set<string>();
        for (const column of columns) {
          if (!column) throw new Error('The header row has an empty column name');
          if (seen.has(column)) throw new Error(`Duplicate column "${column}" in the header`);
          seen.add(column);
        }
        onHeader?.(columns);
        return columns;
      },
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: false,
      info: true,
    }),
  );
  try {
    for await (const item of parser as AsyncIterable<{
      record: Record<string, string>;
      info: { lines: number };
    }>) {
      yield { line: item.info.lines, values: item.record };
    }
  } finally {
    stream.destroy();
  }
}

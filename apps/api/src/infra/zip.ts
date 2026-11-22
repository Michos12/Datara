import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';

const MAX_32 = 0xffffffff;
/** General-purpose flags: sizes in a data descriptor after the data (bit 3), UTF-8 names (bit 11). */
const FLAGS = 0x0808;

interface Entry {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/**
 * Streaming ZIP writer (deflate, no ZIP64): entries are compressed chunk by chunk and written as
 * they are produced, so an archive of any number of rows needs constant memory. Each entry and
 * the whole archive must stay under 4 GiB.
 */
export class ZipWriter {
  private offset = 0;
  private readonly entries: Entry[] = [];
  private readonly time: number;
  private readonly date: number;

  constructor(
    private readonly out: Writable,
    now = new Date(),
  ) {
    this.time =
      (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | Math.floor(now.getUTCSeconds() / 2);
    this.date =
      ((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
  }

  private async put(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (!this.out.write(chunk)) await once(this.out, 'drain');
  }

  /** Adds one file from a sequence of chunks. */
  async add(fileName: string, chunks: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<void> {
    const name = Buffer.from(fileName, 'utf8');
    const offset = this.offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(this.time, 10);
    local.writeUInt16LE(this.date, 12);
    // CRC and sizes (14–25) stay zero: they follow the data in the descriptor.
    local.writeUInt16LE(name.length, 26);
    await this.put(local);
    await this.put(name);

    let crc = 0;
    let size = 0;
    let compressed = 0;
    const deflate = createDeflateRaw();
    const drain = (async () => {
      for await (const piece of deflate as AsyncIterable<Buffer>) {
        compressed += piece.length;
        await this.put(piece);
      }
    })();
    // A failed write to the output must also stop the producer waiting on the deflater.
    drain.catch((err: unknown) => deflate.destroy(err as Error));
    for await (const chunk of chunks) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      if (!deflate.write(chunk)) await once(deflate, 'drain');
    }
    deflate.end();
    await drain;
    if (size > MAX_32 || compressed > MAX_32 || this.offset > MAX_32) {
      throw new Error('Archive too large for ZIP without ZIP64');
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.put(descriptor);
    this.entries.push({ name, crc, compressed, size, offset });
  }

  /** Writes the central directory and ends the output stream. */
  async finish(): Promise<number> {
    const start = this.offset;
    for (const e of this.entries) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4); // version made by
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(FLAGS, 8);
      central.writeUInt16LE(8, 10);
      central.writeUInt16LE(this.time, 12);
      central.writeUInt16LE(this.date, 14);
      central.writeUInt32LE(e.crc, 16);
      central.writeUInt32LE(e.compressed, 20);
      central.writeUInt32LE(e.size, 24);
      central.writeUInt16LE(e.name.length, 28);
      central.writeUInt32LE(e.offset, 42);
      await this.put(central);
      await this.put(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.put(end);
    const total = this.offset;
    await new Promise<void>((resolve, reject) => {
      this.out.once('error', reject);
      this.out.end(() => resolve());
    });
    return total;
  }
}

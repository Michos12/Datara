import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../core/errors.js';

/**
 * Local-disk file storage for uploads and generated files (import error reports).
 * Keys are relative paths like "imports/<org>/<id>.csv". In Docker the directory is a volume
 * shared by the API and the worker; an object store (S3, GCS) can replace this class later.
 */
export class FileStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  /** Absolute path for a key; rejects keys that would escape the storage root. */
  path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  }

  /** Streams `source` to `key`, aborting with 413 once more than `maxBytes` arrive. */
  async write(key: string, source: Readable, maxBytes: number): Promise<number> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(
            new AppError('BAD_REQUEST', `File is larger than ${Math.round(maxBytes / 1048576)} MB`),
          );
        } else {
          callback(null, chunk);
        }
      },
    });
    try {
      await pipeline(source, limiter, createWriteStream(target));
    } catch (err) {
      await rm(target, { force: true });
      throw err;
    }
    return size;
  }

  read(key: string): Readable {
    return createReadStream(this.path(key));
  }

  createWriteStream(key: string) {
    return createWriteStream(this.path(key));
  }

  async ensureDir(key: string): Promise<void> {
    await mkdir(dirname(this.path(key)), { recursive: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

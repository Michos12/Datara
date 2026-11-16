import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Argon2id password hashing with Node's built-in implementation (node:crypto, Node ≥ 24.7).
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum for argon2id:
 * 19 MiB memory, 2 iterations, parallelism 1. Hashes are stored in the standard PHC string
 * format so parameters can be raised later and old hashes still verify.
 */
export const ARGON2_PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const SALT_BYTES = 16;

function derive(
  password: string,
  salt: Buffer,
  params: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: password, nonce: salt, ...params }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, ARGON2_PARAMS);
  const { memory, passes, parallelism } = ARGON2_PARAMS;
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(key)}`;
}

const PHC_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** Constant-time verification. Returns false for malformed hashes instead of throwing. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const match = PHC_RE.exec(stored);
  if (!match) return false;
  const [, m, t, p, saltB64, keyB64] = match;
  const expected = Buffer.from(keyB64!, 'base64');
  const actual = await derive(password, Buffer.from(saltB64!, 'base64'), {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A valid hash of a random secret. Login verifies against it when the email is unknown, so
 * response time does not reveal whether an account exists.
 */
export const DUMMY_PASSWORD_HASH = await hashPassword(randomBytes(32).toString('hex'));

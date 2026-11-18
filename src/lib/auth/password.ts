import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 64;

export function hashPassword(password: string, salt = randomBytes(16).toString("base64url")) {
  const derived = scryptSync(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [scheme, nRaw, rRaw, pRaw, salt, expectedRaw, ...rest] = encoded.split("$");
  if (scheme !== "scrypt" || rest.length || !nRaw || !rRaw || !pRaw || !salt || !expectedRaw) return false;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  try {
    const expected = Buffer.from(expectedRaw, "base64url");
    const actual = scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * 1024 * 1024,
    });
    return expected.length === SCRYPT_KEY_BYTES && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

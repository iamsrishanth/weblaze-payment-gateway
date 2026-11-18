import { createHash, createPublicKey, verify } from "node:crypto";

export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export function makeCanonicalSignatureBytes(input: {
  method: string;
  pathAndQuery: string;
  timestamp: string;
  nonce: string;
  idempotencyKey?: string | null;
  body: Uint8Array;
}) {
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  return [
    "WEBLAZE-OBSERVER/1",
    input.method.toUpperCase(),
    input.pathAndQuery,
    input.timestamp,
    input.nonce,
    input.idempotencyKey ?? "-",
    bodyHash,
  ].join("\n");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
}

export function verifyDetachedP256(input: {
  publicKeyJwk: P256PublicJwk;
  canonicalBytes: string | Uint8Array;
  signatureBase64Url: string;
}) {
  const signature = decodeBase64Url(input.signatureBase64Url);
  if (!signature || signature.length < 64 || signature.length > 80) return false;
  try {
    if (input.publicKeyJwk.kty !== "EC" || input.publicKeyJwk.crv !== "P-256") return false;
    const x = decodeBase64Url(input.publicKeyJwk.x);
    const y = decodeBase64Url(input.publicKeyJwk.y);
    if (!x || !y || x.length !== 32 || y.length !== 32) return false;
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: input.publicKeyJwk.x, y: input.publicKeyJwk.y },
      format: "jwk",
    });
    return verify("sha256", Buffer.from(input.canonicalBytes), key, signature);
  } catch {
    return false;
  }
}

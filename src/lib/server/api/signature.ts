import "server-only";

import { createHash } from "node:crypto";
import { loadGatewayConfig } from "@/lib/config";
import type { DeviceRecord, DeviceScope } from "@/lib/domain/types";
import { makeCanonicalSignatureBytes, verifyDetachedP256 } from "@/lib/observer/signature-core";
import { isValidIdempotencyKey } from "@/lib/observer/validation";
import { HttpError, requestTarget } from "@/lib/server/api/http";
import { getRepository } from "@/lib/server/db/repository";

const CONTRACT_VERSION = "1";
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;

export interface SignedRequestProof {
  deviceId: string;
  nonce: string;
  nonceExpiresAt: Date;
  timestamp: number;
}

function decodeBase64Url(value: string, headerName: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new HttpError(401, "unauthorized", `Invalid ${headerName} header.`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value)
    throw new HttpError(401, "unauthorized", `Invalid ${headerName} header.`);
  return bytes;
}

function readSignatureEnvelope(request: Request, now = Date.now()) {
  const version = request.headers.get("x-weblaze-contract-version");
  if (version !== CONTRACT_VERSION) {
    throw new HttpError(
      409,
      "unsupported_version",
      "This gateway does not support the requested contract version.",
      {
        supportedVersions: [1],
      },
    );
  }
  const timestamp = request.headers.get("x-weblaze-timestamp") ?? "";
  if (!/^\d{13}$/.test(timestamp)) throw new HttpError(401, "unauthorized", "Invalid signature timestamp.");
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber) || Math.abs(now - timestampNumber) > CLOCK_SKEW_MS) {
    throw new HttpError(401, "unauthorized", "Signature timestamp is outside the allowed time window.");
  }
  const nonce = request.headers.get("x-weblaze-nonce") ?? "";
  const nonceBytes = decodeBase64Url(nonce, "X-Weblaze-Nonce");
  if (nonceBytes.length < 16 || nonce.length > 128) {
    throw new HttpError(401, "unauthorized", "Signature nonce must encode at least 16 random bytes.");
  }
  const signature = decodeBase64Url(request.headers.get("x-weblaze-signature") ?? "", "X-Weblaze-Signature");
  if (signature.length < 64 || signature.length > 80) {
    throw new HttpError(401, "unauthorized", "Signature must contain a DER-encoded P-256 signature.");
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null && !isValidIdempotencyKey(idempotencyKey)) {
    throw new HttpError(400, "invalid_request", "Idempotency-Key must use 1–128 allowed ASCII characters.");
  }
  return { timestamp, timestampNumber, nonce, signature, idempotencyKey };
}

export function verifyP256Signature(input: {
  request: Request;
  body: Uint8Array;
  publicKeyJwk: DeviceRecord["publicKeyJwk"];
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const envelope = readSignatureEnvelope(input.request, now);
  const idempotencyKey = envelope.idempotencyKey;
  const canonical = makeCanonicalSignatureBytes({
    method: input.request.method,
    pathAndQuery: requestTarget(input.request),
    timestamp: envelope.timestamp,
    nonce: envelope.nonce,
    idempotencyKey,
    body: input.body,
  });
  const isValid = verifyDetachedP256({
    canonicalBytes: canonical,
    publicKeyJwk: input.publicKeyJwk,
    signatureBase64Url: envelope.signature.toString("base64url"),
  });
  if (!isValid) throw new HttpError(401, "unauthorized", "Request signature did not verify.");
  return {
    nonce: envelope.nonce,
    timestamp: envelope.timestampNumber,
    idempotencyKey,
    nonceExpiresAt: new Date(now + NONCE_TTL_MS),
  } satisfies Omit<SignedRequestProof, "deviceId"> & { idempotencyKey: string | null };
}

export function verifyPairProof(input: {
  request: Request;
  body: Uint8Array;
  publicKeyJwk: DeviceRecord["publicKeyJwk"];
  now?: number;
}) {
  if (input.request.headers.has("x-weblaze-device-id")) {
    throw new HttpError(400, "invalid_request", "Pairing proof must not include a device ID.");
  }
  return verifyP256Signature(input);
}

export async function authenticateSignedDevice(input: {
  request: Request;
  body: Uint8Array;
  requiredScope: DeviceScope;
  persistNonce?: boolean;
}) {
  assertConfiguredOrigin(input.request);
  const deviceId = input.request.headers.get("x-weblaze-device-id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw new HttpError(401, "unauthorized", "A paired device ID is required.");
  }
  const repo = await getRepository();
  const device = await repo.getDevice(deviceId);
  if (!device || device.revokedAt)
    throw new HttpError(401, "unauthorized", "This device is not active on this gateway.");
  const proof = verifyP256Signature({
    request: input.request,
    body: input.body,
    publicKeyJwk: device.publicKeyJwk,
  });
  if (!device.grantedScopes.includes(input.requiredScope)) {
    throw new HttpError(
      403,
      "insufficient_scope",
      `This device does not have the ${input.requiredScope} grant.`,
    );
  }
  const verifiedProof = { deviceId, ...proof };
  if (input.persistNonce !== false) {
    await repo.acceptSignedDeviceRequest({
      deviceId,
      nonce: proof.nonce,
      nonceExpiresAt: proof.nonceExpiresAt,
      requiredScope: input.requiredScope,
    });
  }
  return { device, proof: verifiedProof };
}

export function assertConfiguredOrigin(request: Request) {
  const config = loadGatewayConfig();
  const expected = new URL(config.gatewayPublicOrigin);
  const expectedHost = expected.host.toLowerCase();
  const requestHost = request.headers.get("host")?.toLowerCase();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim().toLowerCase();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  const requestProtocol = new URL(request.url).protocol;
  if (requestHost !== expectedHost || (forwardedHost && forwardedHost !== expectedHost)) {
    throw new HttpError(421, "origin_mismatch", "Pair this phone using the configured gateway host.");
  }
  const isSecure = requestProtocol === "https:" || forwardedProto === "https";
  const isAllowedLocalHttp =
    config.nodeEnv !== "production" &&
    expected.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(expected.hostname);
  if (!isSecure && !isAllowedLocalHttp) {
    throw new HttpError(400, "https_required", "Pairing requires HTTPS on the configured gateway origin.");
  }
  return expected.origin;
}

export function validatePairingCode(value: string) {
  if (!/^[A-Z0-9-]{12,32}$/.test(value))
    throw new HttpError(400, "invalid_request", "Pairing code format is invalid.");
  return value;
}

export function hashPairingCode(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function ensureApiVersion(request: Request) {
  if (request.headers.get("x-weblaze-contract-version") !== CONTRACT_VERSION) {
    throw new HttpError(
      409,
      "unsupported_version",
      "This gateway does not support the requested contract version.",
      {
        supportedVersions: [1],
      },
    );
  }
}

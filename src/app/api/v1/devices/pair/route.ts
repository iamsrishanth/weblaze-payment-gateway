import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getPublicGatewayConfig, loadGatewayConfig } from "@/lib/config";
import { pairingResponse } from "@/lib/observer/checkout";
import {
  apiError,
  asApiError,
  HttpError,
  NO_STORE_HEADERS,
  parseJsonBody,
  readBoundedBody,
  requireJsonContentType,
} from "@/lib/server/api/http";
import { enforceRateLimit } from "@/lib/server/api/rate-limit";
import { pairDeviceBodySchema } from "@/lib/server/api/schemas";
import {
  assertConfiguredOrigin,
  ensureApiVersion,
  hashPairingCode,
  validatePairingCode,
  verifyPairProof,
} from "@/lib/server/api/signature";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    ensureApiVersion(request);
    requireJsonContentType(request);
    await enforceRateLimit(request, "device-pairing", 10, 600);
    const canonicalOrigin = assertConfiguredOrigin(request);
    const bytes = await readBoundedBody(request);
    const parsed = pairDeviceBodySchema.safeParse(parseJsonBody<unknown>(bytes));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Pairing request fields are invalid.");
    const body = parsed.data;
    const pairingCode = validatePairingCode(body.pairingCode);
    const proof = verifyPairProof({ request, body: bytes, publicKeyJwk: body.publicKey });
    const repo = await getRepository();
    const device = await repo.pairDevice({
      pairingCodeHash: hashPairingCode(pairingCode),
      deviceId: randomUUID(),
      deviceName: body.deviceName,
      publicKeyJwk: body.publicKey,
      nonce: proof.nonce,
      nonceExpiresAt: proof.nonceExpiresAt,
      pairedAt: new Date(),
    });
    return NextResponse.json(
      pairingResponse({
        ...getPublicGatewayConfig(loadGatewayConfig()),
        gatewayOrigin: canonicalOrigin,
        device,
      }),
      { status: 201, headers: { ...NO_STORE_HEADERS } },
    );
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

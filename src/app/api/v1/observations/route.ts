import { NextResponse } from "next/server";
import {
  apiError,
  asApiError,
  HttpError,
  NO_STORE_HEADERS,
  parseJsonBody,
  readBoundedBody,
  requireJsonContentType,
} from "@/lib/server/api/http";
import { enforceDeviceRateLimit } from "@/lib/server/api/rate-limit";
import { observationBodySchema } from "@/lib/server/api/schemas";
import { authenticateSignedDevice, ensureApiVersion } from "@/lib/server/api/signature";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    ensureApiVersion(request);
    requireJsonContentType(request);
    const bytes = await readBoundedBody(request);
    const parsed = observationBodySchema.safeParse(parseJsonBody<unknown>(bytes));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Observation fields are invalid.");
    const { device, proof } = await authenticateSignedDevice({
      request,
      body: bytes,
      requiredScope: "observations",
      persistNonce: false,
    });
    await enforceDeviceRateLimit(device.id, "device-observation-upload", 120, 60);
    const repo = await getRepository();
    const result = await repo.ingestObservation({
      deviceId: device.id,
      nonce: proof.nonce,
      nonceExpiresAt: proof.nonceExpiresAt,
      receivedAt: new Date(),
      event: parsed.data,
    });
    return NextResponse.json(result, {
      status: result.duplicate ? 200 : 202,
      headers: { ...NO_STORE_HEADERS },
    });
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

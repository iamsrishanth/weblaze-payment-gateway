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
import { authenticateSignedDevice, ensureApiVersion } from "@/lib/server/api/signature";
import { getRepository } from "@/lib/server/db/repository";
import {
  createOrderBodySchema,
  paymentLinkResponse,
  prepareOrderInput,
  validateIdempotencyKey,
} from "@/lib/server/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    ensureApiVersion(request);
    requireJsonContentType(request);
    const bytes = await readBoundedBody(request);
    const parsed = createOrderBodySchema.safeParse(parseJsonBody<unknown>(bytes));
    if (!parsed.success)
      throw new HttpError(400, "invalid_request", "Amount, description, or expiry is invalid.");
    const { device, proof } = await authenticateSignedDevice({
      request,
      body: bytes,
      requiredScope: "links:create",
      persistNonce: false,
    });
    await enforceDeviceRateLimit(device.id, "device-payment-link-create", 30, 60);
    const idempotencyKey = validateIdempotencyKey(proof.idempotencyKey);
    const input = prepareOrderInput({
      body: parsed.data,
      idempotencyKey,
      idempotencyScope: `device:${device.id}`,
      method: "POST",
      path: "/api/v1/payment-links",
      createdByDeviceId: device.id,
    });
    const repo = await getRepository();
    const order = await repo.createDevicePaymentLink({
      order: input,
      deviceId: device.id,
      nonce: proof.nonce,
      nonceExpiresAt: proof.nonceExpiresAt,
    });
    return NextResponse.json(paymentLinkResponse(order), { status: 200, headers: { ...NO_STORE_HEADERS } });
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

export async function GET(request: Request) {
  try {
    ensureApiVersion(request);
    const { device } = await authenticateSignedDevice({
      request,
      body: Buffer.alloc(0),
      requiredScope: "links:read_own",
    });
    await enforceDeviceRateLimit(device.id, "device-payment-link-list", 120, 60);
    const repo = await getRepository();
    const links = await repo.listDevicePaymentLinks(device.id, 100);
    return NextResponse.json(
      { links: links.map(paymentLinkResponse) },
      { status: 200, headers: { ...NO_STORE_HEADERS } },
    );
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

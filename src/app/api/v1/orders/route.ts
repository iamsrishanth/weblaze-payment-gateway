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
import { requireMerchantApiKey } from "@/lib/server/api/merchant-auth";
import { enforceRateLimit } from "@/lib/server/api/rate-limit";
import {
  createOrder,
  parseCreateOrderBody,
  paymentLinkResponse,
  validateIdempotencyKey,
} from "@/lib/server/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireJsonContentType(request);
    const bytes = await readBoundedBody(request);
    const body = parseCreateOrderBody(parseJsonBody<unknown>(bytes));
    requireMerchantApiKey(request);
    await enforceRateLimit(request, "merchant-order-create", 120, 60);
    const idempotencyKey = validateIdempotencyKey(request.headers.get("idempotency-key"));
    const order = await createOrder({ body, idempotencyKey, idempotencyScope: "merchant-api" });
    return NextResponse.json(paymentLinkResponse(order), { status: 200, headers: { ...NO_STORE_HEADERS } });
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

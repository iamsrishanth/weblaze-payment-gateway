import { NextResponse } from "next/server";
import { readAdminJson } from "@/lib/server/api/admin";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { enforceRateLimit } from "@/lib/server/api/rate-limit";
import {
  createOrder,
  createOrderBodySchema,
  paymentLinkResponse,
  validateIdempotencyKey,
} from "@/lib/server/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "admin-order-create", 60, 60);
    const { session, data } = await readAdminJson(request, createOrderBodySchema);
    const idempotencyKey = validateIdempotencyKey(request.headers.get("idempotency-key"));
    const order = await createOrder({
      body: data,
      idempotencyKey,
      idempotencyScope: `dashboard:${session.adminId}`,
      method: "POST",
      path: "/api/admin/orders",
    });
    return NextResponse.json(paymentLinkResponse(order), { status: 200, headers: { ...NO_STORE_HEADERS } });
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

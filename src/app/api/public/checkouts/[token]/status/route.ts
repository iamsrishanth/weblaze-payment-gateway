import { NextResponse } from "next/server";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { enforceRateLimit } from "@/lib/server/api/rate-limit";
import { getRepository } from "@/lib/server/db/repository";
import { customerStatusLabel } from "@/lib/server/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    await enforceRateLimit(request, "public-checkout-status", 120, 60);
    const { token } = await context.params;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(404, "not_found", "Checkout was not found.");
    const repo = await getRepository();
    const order = await repo.getOrderByToken(token);
    if (!order) throw new HttpError(404, "not_found", "Checkout was not found.");
    const current = (await repo.expireOrderIfDue(order.id, new Date())) ?? order;
    return NextResponse.json(
      {
        orderId: current.id,
        merchantRef: current.merchantRef,
        amountPaise: current.amountPaise,
        currency: current.currency,
        status: current.status,
        customerStatusLabel: customerStatusLabel(current.status),
        expiresAt: current.expiresAt.toISOString(),
      },
      { status: 200, headers: { ...NO_STORE_HEADERS } },
    );
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

import { NextResponse } from "next/server";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { requireMerchantApiKey } from "@/lib/server/api/merchant-auth";
import { enforceRateLimit } from "@/lib/server/api/rate-limit";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ orderId: string }> }) {
  try {
    requireMerchantApiKey(request);
    await enforceRateLimit(request, "merchant-order-status", 300, 60);
    const { orderId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
      throw new HttpError(404, "not_found", "Order was not found.");
    }
    const repo = await getRepository();
    const order = await repo.getOrderById(orderId);
    if (!order) throw new HttpError(404, "not_found", "Order was not found.");
    const expired = await repo.expireOrderIfDue(order.id, new Date());
    const current = expired ?? order;
    return NextResponse.json(
      {
        orderId: current.id,
        merchantRef: current.merchantRef,
        amountPaise: current.amountPaise,
        currency: current.currency,
        status: current.status,
        expiresAt: current.expiresAt.toISOString(),
        paymentSource: current.paymentSource,
        bankReconciliationStatus: current.bankReconciliationStatus,
        reconciledAt: current.reconciledAt?.toISOString() ?? null,
      },
      { status: 200, headers: { ...NO_STORE_HEADERS } },
    );
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

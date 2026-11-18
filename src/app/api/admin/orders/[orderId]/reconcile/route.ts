import { NextResponse } from "next/server";
import { readAdminJson } from "@/lib/server/api/admin";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { reconcileSchema } from "@/lib/server/api/schemas";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  try {
    const { session, data } = await readAdminJson(request, reconcileSchema);
    const { orderId } = await context.params;
    if (data.orderId !== orderId)
      throw new HttpError(400, "invalid_request", "Order ID in the URL and body do not match.");
    const repo = await getRepository();
    await repo.reconcileOrder({
      orderId,
      actorId: session.adminId,
      officialBankReference: data.officialBankReference,
      reason: data.reason,
    });
    return NextResponse.json({ ok: true }, { status: 200, headers: { ...NO_STORE_HEADERS } });
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

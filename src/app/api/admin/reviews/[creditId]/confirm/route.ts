import { NextResponse } from "next/server";
import { readAdminJson } from "@/lib/server/api/admin";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { manualReviewSchema } from "@/lib/server/api/schemas";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ creditId: string }> }) {
  try {
    const { session, data } = await readAdminJson(request, manualReviewSchema);
    const { creditId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(creditId)) {
      throw new HttpError(404, "not_found", "Review credit was not found.");
    }
    const repo = await getRepository();
    await repo.reviewCredit({
      creditId,
      orderId: data.orderId,
      actorId: session.adminId,
      reason: data.reason,
      evidenceReference: data.evidenceReference,
      officialBankReference: data.officialBankReference,
    });
    return NextResponse.json({ ok: true }, { status: 200, headers: { ...NO_STORE_HEADERS } });
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

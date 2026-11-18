import { NextResponse } from "next/server";
import { requireAdminMutation } from "@/lib/server/api/admin";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ deviceId: string }> }) {
  try {
    const session = await requireAdminMutation(request);
    const { deviceId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
      throw new HttpError(404, "not_found", "Device was not found.");
    }
    const repo = await getRepository();
    const device = await repo.revokeDevice(deviceId, session.adminId);
    return NextResponse.json(
      { id: device.id, revokedAt: device.revokedAt?.toISOString() ?? new Date().toISOString() },
      { status: 200, headers: { ...NO_STORE_HEADERS } },
    );
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

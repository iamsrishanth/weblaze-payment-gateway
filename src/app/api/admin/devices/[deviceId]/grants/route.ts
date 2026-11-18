import { NextResponse } from "next/server";
import { readAdminJson } from "@/lib/server/api/admin";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { grantUpdateSchema } from "@/lib/server/api/schemas";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ deviceId: string }> }) {
  try {
    const { data } = await readAdminJson(request, grantUpdateSchema);
    const { deviceId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
      throw new HttpError(404, "not_found", "Device was not found.");
    }
    const repo = await getRepository();
    const device = await repo.updateDeviceGrants(deviceId, data.grantedScopes);
    return NextResponse.json(
      { id: device.id, grantedScopes: device.grantedScopes },
      { status: 200, headers: { ...NO_STORE_HEADERS } },
    );
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

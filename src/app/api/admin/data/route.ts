import { NextResponse } from "next/server";
import { getAdminTerminalData } from "@/lib/server/admin-data";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { requireAdmin } from "@/lib/server/auth/require-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    const data = await getAdminTerminalData();
    return NextResponse.json(data, { status: 200, headers: { ...NO_STORE_HEADERS } });
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

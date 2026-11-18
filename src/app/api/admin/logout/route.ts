import { NextResponse } from "next/server";
import { requireAdminMutation } from "@/lib/server/api/admin";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { ADMIN_SESSION_COOKIE, adminCookieOptions } from "@/lib/server/auth/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireAdminMutation(request);
    const response = NextResponse.json({ ok: true }, { status: 200, headers: { ...NO_STORE_HEADERS } });
    response.cookies.set(ADMIN_SESSION_COOKIE, "", adminCookieOptions(0));
    return response;
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

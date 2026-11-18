import { NextResponse } from "next/server";
import { readSameOriginJson } from "@/lib/server/api/admin";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { enforceRateLimit } from "@/lib/server/api/rate-limit";
import { adminLoginSchema } from "@/lib/server/api/schemas";
import {
  ADMIN_SESSION_COOKIE,
  adminCookieOptions,
  createAdminSessionToken,
} from "@/lib/server/auth/admin-session";
import { hashPassword, verifyPassword } from "@/lib/server/auth/credentials";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "admin-login", 8, 300);
    const { data } = await readSameOriginJson(request, adminLoginSchema);
    const email = data.email.toLowerCase();
    const repo = await getRepository();
    const admin = await repo.getAdminByEmail(email);
    const passMatches = verifyPassword(data.password, admin?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!admin || !passMatches)
      throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
    const session = createAdminSessionToken(admin.id, admin.email);
    const response = NextResponse.json({ ok: true }, { status: 200, headers: { ...NO_STORE_HEADERS } });
    response.cookies.set(ADMIN_SESSION_COOKIE, session.value, adminCookieOptions(session.maxAge));
    return response;
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}

const DUMMY_PASSWORD_HASH = hashPassword("not-an-operator-password", "AAAAAAAAAAAAAAAAAAAAAA");

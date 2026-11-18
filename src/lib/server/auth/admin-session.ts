import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { loadGatewayConfig } from "@/lib/config";

export const ADMIN_SESSION_COOKIE = "weblaze_admin_session";
const SESSION_LIFETIME_SECONDS = 12 * 60 * 60;

export interface AdminSession {
  adminId: string;
  email: string;
  expiresAt: number;
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function createAdminSessionToken(adminId: string, email: string, now = Date.now()) {
  const config = loadGatewayConfig();
  const payload: AdminSession = {
    adminId,
    email,
    expiresAt: Math.floor(now / 1000) + SESSION_LIFETIME_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { value: `v1.${encoded}.${sign(encoded, config.sessionSecret)}`, maxAge: SESSION_LIFETIME_SECONDS };
}

export function verifyAdminSessionToken(value: string | undefined, now = Date.now()): AdminSession | null {
  if (!value) return null;
  const [version, encoded, signature, extra] = value.split(".");
  if (version !== "v1" || !encoded || !signature || extra) return null;
  try {
    const config = loadGatewayConfig();
    const expected = Buffer.from(sign(encoded, config.sessionSecret), "base64url");
    const actual = Buffer.from(signature, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AdminSession;
    if (
      !parsed.adminId ||
      !parsed.email ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt <= Math.floor(now / 1000)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const jar = await cookies();
  return verifyAdminSessionToken(jar.get(ADMIN_SESSION_COOKIE)?.value);
}

export function adminCookieOptions(maxAge = SESSION_LIFETIME_SECONDS) {
  const config = loadGatewayConfig();
  return {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}

export function generateAdminCsrfToken() {
  return randomBytes(32).toString("base64url");
}

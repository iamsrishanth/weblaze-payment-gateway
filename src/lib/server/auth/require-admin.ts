import "server-only";

import { HttpError } from "@/lib/server/api/http";
import { getAdminSession } from "@/lib/server/auth/admin-session";

export async function requireAdmin() {
  const session = await getAdminSession();
  if (!session) throw new HttpError(401, "unauthorized", "Sign in to the merchant terminal first.");
  return session;
}

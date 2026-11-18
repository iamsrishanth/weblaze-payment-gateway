import "server-only";

import type { z } from "zod";
import { loadGatewayConfig } from "@/lib/config";
import {
  HttpError,
  isSameOriginMutation,
  parseJsonBody,
  readBoundedBody,
  requireJsonContentType,
} from "@/lib/server/api/http";
import { requireAdmin } from "@/lib/server/auth/require-admin";

export async function readAdminJson<Schema extends z.ZodType>(request: Request, schema: Schema) {
  const session = await requireAdmin();
  const parsed = await readSameOriginJson(request, schema);
  return { session, data: parsed.data };
}

export async function readSameOriginJson<Schema extends z.ZodType>(request: Request, schema: Schema) {
  isSameOriginMutation(request, loadGatewayConfig().gatewayPublicOrigin);
  requireJsonContentType(request);
  const bytes = await readBoundedBody(request, 8192);
  const result = schema.safeParse(parseJsonBody<unknown>(bytes));
  if (!result.success) throw new HttpError(400, "invalid_request", "Some form fields are invalid.");
  return { data: result.data as z.infer<Schema> };
}

export async function requireAdminMutation(request: Request) {
  const session = await requireAdmin();
  isSameOriginMutation(request, loadGatewayConfig().gatewayPublicOrigin);
  return session;
}

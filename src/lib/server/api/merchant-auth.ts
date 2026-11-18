import "server-only";

import { loadGatewayConfig } from "@/lib/config";
import { HttpError } from "@/lib/server/api/http";
import { fixedTimeStringEqual } from "@/lib/server/auth/credentials";

export function requireMerchantApiKey(request: Request) {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]{32,})$/);
  if (!match || !fixedTimeStringEqual(match[1], loadGatewayConfig().merchantApiKey)) {
    throw new HttpError(401, "unauthorized", "A valid merchant API bearer key is required.");
  }
}

import "server-only";

import { createHmac } from "node:crypto";
import { loadGatewayConfig } from "@/lib/config";
import { deviceRateKey } from "@/lib/observer/rate-limit";
import { HttpError } from "@/lib/server/api/http";
import { getRepository } from "@/lib/server/db/repository";

export function requestRateKey(request: Request, namespace: string) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const remote = forwarded || realIp || "unknown";
  return createHmac("sha256", loadGatewayConfig().sessionSecret)
    .update(`${namespace}\n${remote}`, "utf8")
    .digest("hex");
}

export async function enforceRateLimit(
  request: Request,
  namespace: string,
  limit: number,
  windowSeconds: number,
) {
  const repo = await getRepository();
  const allowed = await repo.allowRateLimit(
    requestRateKey(request, namespace),
    limit,
    windowSeconds,
    new Date(),
  );
  if (!allowed) {
    throw new HttpError(429, "rate_limited", "Too many requests. Try again shortly.", {
      retryAfterSeconds: windowSeconds,
    });
  }
}

export async function enforceDeviceRateLimit(
  deviceId: string,
  namespace: string,
  limit: number,
  windowSeconds: number,
) {
  const config = loadGatewayConfig();
  const repo = await getRepository();
  const allowed = await repo.allowRateLimit(
    deviceRateKey(deviceId, namespace, config.sessionSecret),
    limit,
    windowSeconds,
    new Date(),
  );
  if (!allowed) {
    throw new HttpError(
      429,
      "rate_limited",
      "This device has reached its request limit. Try again shortly.",
      { retryAfterSeconds: windowSeconds },
    );
  }
}

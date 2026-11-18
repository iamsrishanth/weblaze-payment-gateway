import { createHash, randomBytes } from "node:crypto";
import type { NewOrderInput } from "@/lib/domain/types";

export interface FixedOrderRequestBody {
  amountPaise: number;
  description?: string | null;
  expiresAt?: string | null;
}

export interface InstancePaymentConfig {
  merchantDisplayName: string;
  upiPayeeVpa: string;
}

export function fingerprintOrderRequest(input: {
  body: FixedOrderRequestBody;
  idempotencyKey: string;
  method: string;
  path: string;
}) {
  const normalized = JSON.stringify({
    method: input.method.toUpperCase(),
    path: input.path,
    idempotencyKey: input.idempotencyKey,
    amountPaise: input.body.amountPaise,
    description: input.body.description ?? null,
    expiresAt: input.body.expiresAt ?? null,
  });
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function makeNewOrderInput(input: {
  body: FixedOrderRequestBody;
  config: InstancePaymentConfig;
  idempotencyKey: string;
  idempotencyScope: string;
  method: string;
  path: string;
  createdByDeviceId?: string | null;
  now?: Date;
}): NewOrderInput {
  const now = input.now ?? new Date();
  const expiresAt = input.body.expiresAt
    ? new Date(input.body.expiresAt)
    : new Date(now.getTime() + 15 * 60 * 1000);
  return {
    amountPaise: input.body.amountPaise,
    description: input.body.description ?? null,
    expiresAt,
    merchantDisplayName: input.config.merchantDisplayName,
    payeeVpa: input.config.upiPayeeVpa,
    idempotencyScope: input.idempotencyScope,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: fingerprintOrderRequest({
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      method: input.method,
      path: input.path,
    }),
    createdByDeviceId: input.createdByDeviceId ?? null,
    merchantRef: `WZ${randomBytes(12).toString("hex").toUpperCase()}`,
    publicToken: randomBytes(32).toString("base64url"),
  };
}

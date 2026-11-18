import "server-only";

import { z } from "zod";
import { loadGatewayConfig } from "@/lib/config";
import type { PaymentOrderRecord } from "@/lib/domain/types";
import {
  buildUpiPaymentUri as buildUpiUri,
  paymentLinkResponse as makePaymentLinkResponse,
} from "@/lib/observer/checkout";
import { makeNewOrderInput } from "@/lib/observer/order-input";
import { containsControlCharacters, isUtcDateTime, isValidIdempotencyKey } from "@/lib/observer/validation";
import { HttpError } from "@/lib/server/api/http";
import { getRepository } from "@/lib/server/db/repository";

export const MIN_AMOUNT_PAISE = 1;
export const MAX_AMOUNT_PAISE = 10_000_000;
export const DEFAULT_EXPIRY_MS = 15 * 60 * 1000;
export const MIN_EXPIRY_MS = 60 * 1000;
export const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000;

const utcDateTime = z.string().refine(isUtcDateTime);

export const createOrderBodySchema = z
  .object({
    amountPaise: z.number().int().min(MIN_AMOUNT_PAISE).max(MAX_AMOUNT_PAISE),
    description: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => !containsControlCharacters(value), "Description must be plain printable text.")
      .nullable()
      .optional(),
    expiresAt: utcDateTime.nullable().optional(),
  })
  .strict();

export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;

export function parseCreateOrderBody(input: unknown): CreateOrderBody {
  const parsed = createOrderBodySchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, "invalid_request", "Amount, description, or expiry is invalid.");
  }
  return parsed.data;
}

export function validateIdempotencyKey(value: string | null) {
  if (!value || !isValidIdempotencyKey(value)) {
    throw new HttpError(400, "invalid_request", "Idempotency-Key must use 1–128 allowed ASCII characters.");
  }
  return value;
}

export function prepareOrderInput(input: {
  body: CreateOrderBody;
  idempotencyKey: string;
  idempotencyScope: string;
  method?: string;
  path?: string;
  createdByDeviceId?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const config = loadGatewayConfig();
  return makeNewOrderInput({
    body: input.body,
    config,
    idempotencyScope: input.idempotencyScope,
    idempotencyKey: input.idempotencyKey,
    method: input.method ?? "POST",
    path: input.path ?? "/api/v1/orders",
    createdByDeviceId: input.createdByDeviceId,
    now,
  });
}

export async function createOrder(input: {
  body: CreateOrderBody;
  idempotencyKey: string;
  idempotencyScope: string;
  method?: string;
  path?: string;
  createdByDeviceId?: string | null;
  now?: Date;
}): Promise<PaymentOrderRecord> {
  const repo = await getRepository();
  const order = await repo.createOrder(prepareOrderInput(input));
  return order;
}

export function checkoutUrl(order: PaymentOrderRecord) {
  return `${loadGatewayConfig().gatewayPublicOrigin}/checkout/${order.publicToken}`;
}

export function paymentLinkResponse(order: PaymentOrderRecord) {
  return makePaymentLinkResponse(order, loadGatewayConfig().gatewayPublicOrigin);
}

export function buildUpiPaymentUri(order: PaymentOrderRecord) {
  return buildUpiUri(order);
}

export function customerStatusLabel(status: PaymentOrderRecord["status"]) {
  switch (status) {
    case "notification_confirmed":
      return "Payment notification received";
    case "needs_review":
      return "Payment being reviewed";
    case "expired":
      return "Link expired";
    case "pending":
      return "Awaiting payment";
  }
}

export function merchantStatusLabel(status: PaymentOrderRecord["status"]) {
  switch (status) {
    case "notification_confirmed":
      return "Payment observed";
    case "needs_review":
      return "Needs review";
    case "expired":
      return "Expired";
    case "pending":
      return "Awaiting payment";
  }
}

export function formatInr(amountPaise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(amountPaise / 100);
}

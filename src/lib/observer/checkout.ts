import type { DeviceRecord, PaymentOrderRecord } from "@/lib/domain/types";

export function buildUpiPaymentUri(
  order: Pick<
    PaymentOrderRecord,
    "payeeVpaSnapshot" | "merchantDisplayNameSnapshot" | "amountPaise" | "merchantRef"
  >,
) {
  const amount = `${Math.floor(order.amountPaise / 100)}.${String(order.amountPaise % 100).padStart(2, "0")}`;
  const values: [string, string][] = [
    ["pa", order.payeeVpaSnapshot],
    ["pn", order.merchantDisplayNameSnapshot],
    ["am", amount],
    ["cu", "INR"],
    ["tr", order.merchantRef],
  ];
  return `upi://pay?${values.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}

export function paymentLinkResponse(order: PaymentOrderRecord, gatewayPublicOrigin: string) {
  return {
    orderId: order.id,
    merchantRef: order.merchantRef,
    amountPaise: order.amountPaise,
    description: order.description,
    expiresAt: order.expiresAt.toISOString(),
    status: order.status,
    checkoutUrl: `${gatewayPublicOrigin}/checkout/${order.publicToken}`,
  };
}

export function pairingResponse(input: {
  gatewayOrigin: string;
  merchantDisplayName: string;
  payeeVpa: string;
  device: Pick<DeviceRecord, "id" | "grantedScopes">;
}) {
  return {
    gatewayOrigin: input.gatewayOrigin,
    merchantDisplayName: input.merchantDisplayName,
    payeeVpa: input.payeeVpa,
    currency: "INR" as const,
    apiVersion: "1.0.0" as const,
    deviceId: input.device.id,
    grantedScopes: input.device.grantedScopes,
  };
}

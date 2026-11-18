import "server-only";

import { loadGatewayConfig } from "@/lib/config";
import type { DeviceScope } from "@/lib/domain/types";
import { getRepository } from "@/lib/server/db/repository";
import { formatInr, merchantStatusLabel, paymentLinkResponse } from "@/lib/server/orders";

function maskReference(value: string | null) {
  return value ? `••••${value.slice(-4)}` : null;
}

export async function getAdminTerminalData() {
  const config = loadGatewayConfig();
  const repo = await getRepository();
  await repo.expireAllOrdersDue(new Date());
  const [orders, devices, pairingCredentials, reviewQueue, receiverAccounts, receiverProfiles] =
    await Promise.all([
      repo.listRecentOrders(50),
      repo.listDevices(),
      repo.listPairingCredentials(),
      repo.listReviewQueue(100),
      repo.listReceiverAccounts(),
      repo.listReceiverProfiles(),
    ]);
  return {
    gatewayOrigin: config.gatewayPublicOrigin,
    merchantDisplayName: config.merchantDisplayName,
    payeeVpa: config.upiPayeeVpa,
    currency: "INR" as const,
    scopeOptions: ["observations", "links:create", "links:read_own"] as DeviceScope[],
    orders: orders.map((order) => ({
      ...paymentLinkResponse(order),
      amountLabel: formatInr(order.amountPaise),
      createdAt: order.createdAt.toISOString(),
      createdByDeviceId: order.createdByDeviceId,
      paymentSource: order.paymentSource,
      reconciliationStatus: order.bankReconciliationStatus,
      reconciledAt: order.reconciledAt?.toISOString() ?? null,
      reconciledBy: order.reconciledBy,
      maskedOfficialBankReference: maskReference(order.officialBankReference),
      statusLabel: merchantStatusLabel(order.status),
    })),
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      grantedScopes: device.grantedScopes,
      revokedAt: device.revokedAt?.toISOString() ?? null,
      createdAt: device.createdAt.toISOString(),
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    })),
    pairingCredentials: pairingCredentials.map((credential) => ({
      id: credential.id,
      grantedScopes: credential.grantedScopes,
      expiresAt: credential.expiresAt.toISOString(),
      usedAt: credential.usedAt?.toISOString() ?? null,
      createdAt: credential.createdAt.toISOString(),
    })),
    reviewQueue: reviewQueue.map((item) => ({
      creditId: item.creditId,
      candidateOrderId: item.candidateOrderId,
      candidateMerchantRef: item.candidateMerchantRef,
      amountPaise: item.amountPaise,
      amountLabel: formatInr(item.amountPaise),
      observedAt: item.observedAt.toISOString(),
      source: item.source,
      maskedBankRef: item.maskedBankRef,
      maskedMerchantRef: item.maskedMerchantRef,
      reason: item.reason,
    })),
    receiverAccounts: receiverAccounts.map((account) => ({
      id: account.id,
      label: account.label,
      payeeVpa: account.payeeVpa,
      maskedAccountSuffix: account.maskedAccountSuffix,
      verifiedAt: account.verifiedAt?.toISOString() ?? null,
      verifiedBy: account.verifiedBy,
    })),
    receiverProfiles: receiverProfiles.map((profile) => ({
      id: profile.id,
      receiverAccountId: profile.receiverAccountId,
      deviceId: profile.deviceId,
      source: profile.source,
      sourceTemplateId: profile.sourceTemplateId,
      active: profile.active,
      createdAt: profile.createdAt.toISOString(),
    })),
  };
}

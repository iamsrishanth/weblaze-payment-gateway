export type PaymentStatus = "pending" | "notification_confirmed" | "needs_review" | "expired";

export type ObservationSource = "phonepe" | "bank_sms";
export type ObservationKind = "incoming_credit" | "reversal";
export type DeviceScope = "observations" | "links:create" | "links:read_own";

export interface CanonicalObservationV1 {
  schemaVersion: 1;
  eventId: string;
  source: ObservationSource;
  eventKind: ObservationKind;
  observedAt: string;
  amountPaise: number;
  currency: "INR";
  merchantRef: string | null;
  bankRef: string | null;
  observedPayeeVpa: string | null;
  receiverProfileId: string | null;
  sourceTransactionId: string | null;
  sourceTemplateId: string | null;
}

export interface PaymentOrderRecord {
  id: string;
  merchantRef: string;
  amountPaise: number;
  currency: "INR";
  description: string | null;
  status: PaymentStatus;
  createdAt: Date;
  expiresAt: Date;
  merchantDisplayNameSnapshot: string;
  payeeVpaSnapshot: string;
  publicToken: string;
  createdByDeviceId: string | null;
  paymentSource: ObservationSource | null;
  bankReconciliationStatus: "unreconciled" | "reconciled";
  reconciledAt: Date | null;
  reconciledBy: string | null;
  officialBankReference: string | null;
}

export interface NewOrderInput {
  amountPaise: number;
  description: string | null;
  expiresAt: Date;
  merchantDisplayName: string;
  payeeVpa: string;
  idempotencyScope: string;
  idempotencyKey: string;
  requestFingerprint: string;
  createdByDeviceId: string | null;
  merchantRef: string;
  publicToken: string;
}

export interface DeviceRecord {
  id: string;
  name: string;
  publicKeyJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  grantedScopes: DeviceScope[];
  revokedAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date | null;
}

export interface PairingCredentialRecord {
  id: string;
  codeHash: string;
  expiresAt: Date;
  grantedScopes: DeviceScope[];
  usedAt: Date | null;
  createdAt: Date;
}

export interface ReceiverAccountRecord {
  id: string;
  label: string;
  payeeVpa: string;
  verifiedAt: Date | null;
  verifiedBy: string | null;
}

export interface ReceiverProfileRecord {
  id: string;
  receiverAccountId: string;
  deviceId: string;
  source: ObservationSource;
  sourceTemplateId: string | null;
  active: boolean;
  createdAt: Date;
}

export interface ReviewQueueItem {
  creditId: string;
  candidateOrderId: string | null;
  candidateMerchantRef: string | null;
  amountPaise: number;
  observedAt: Date;
  source: ObservationSource;
  maskedBankRef: string | null;
  maskedMerchantRef: string | null;
  reason: string;
}

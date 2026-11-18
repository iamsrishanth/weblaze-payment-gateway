import type {
  CanonicalObservationV1,
  DeviceRecord,
  DeviceScope,
  DiscoveredReceiverProfile,
  NewOrderInput,
  ObservationSource,
  PairingCredentialRecord,
  PaymentOrderRecord,
  ReceiverAccountRecord,
  ReceiverProfileRecord,
  ReviewQueueItem,
} from "@/lib/domain/types";

export interface AdminRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface PairDeviceInput {
  pairingCodeHash: string;
  deviceId: string;
  deviceName: string;
  publicKeyJwk: DeviceRecord["publicKeyJwk"];
  nonce: string;
  nonceExpiresAt: Date;
  pairedAt: Date;
}

export interface DevicePaymentLinkInput {
  order: NewOrderInput;
  deviceId: string;
  nonce: string;
  nonceExpiresAt: Date;
}

export interface SignedDeviceRequestInput {
  deviceId: string;
  nonce: string;
  nonceExpiresAt: Date;
  requiredScope: DeviceScope;
}

export interface ObservationIngestInput {
  deviceId: string;
  nonce: string;
  nonceExpiresAt: Date;
  receivedAt: Date;
  event: CanonicalObservationV1;
}

export interface ReviewCreditInput {
  creditId: string;
  orderId: string;
  actorId: string;
  reason: string;
  evidenceReference: string;
  officialBankReference: string;
}

export interface ReconcileOrderInput {
  orderId: string;
  actorId: string;
  officialBankReference: string;
  reason: string;
}

export interface CreateReceiverAccountInput {
  label: string;
  payeeVpa: string;
  maskedAccountSuffix?: string | null;
  verifiedBy: string;
  verified: boolean;
}

export interface CreateReceiverProfileInput {
  receiverAccountId: string;
  deviceId: string;
  source: ObservationSource;
  sourceTemplateId: string | null;
}

export interface GatewayRepository {
  createOrder(input: NewOrderInput): Promise<PaymentOrderRecord>;
  getOrderById(orderId: string): Promise<PaymentOrderRecord | null>;
  getOrderByToken(token: string): Promise<PaymentOrderRecord | null>;
  expireOrderIfDue(orderId: string, now: Date): Promise<PaymentOrderRecord | null>;
  expireAllOrdersDue(now: Date): Promise<number>;
  listRecentOrders(limit: number): Promise<PaymentOrderRecord[]>;

  createPairingCredential(input: {
    codeHash: string;
    expiresAt: Date;
    grantedScopes: DeviceScope[];
    createdBy: string;
  }): Promise<PairingCredentialRecord>;
  listPairingCredentials(): Promise<PairingCredentialRecord[]>;
  pairDevice(input: PairDeviceInput): Promise<DeviceRecord>;
  getDevice(deviceId: string): Promise<DeviceRecord | null>;
  listDevices(): Promise<DeviceRecord[]>;
  updateDeviceGrants(deviceId: string, grantedScopes: DeviceScope[]): Promise<DeviceRecord>;
  revokeDevice(deviceId: string, actorId: string): Promise<DeviceRecord>;
  acceptSignedDeviceRequest(input: SignedDeviceRequestInput): Promise<void>;

  createDevicePaymentLink(input: DevicePaymentLinkInput): Promise<PaymentOrderRecord>;
  listDevicePaymentLinks(deviceId: string, limit: number): Promise<PaymentOrderRecord[]>;
  ingestObservation(input: ObservationIngestInput): Promise<{ accepted: true; duplicate: boolean }>;

  listReviewQueue(limit: number): Promise<ReviewQueueItem[]>;
  reviewCredit(input: ReviewCreditInput): Promise<void>;
  reconcileOrder(input: ReconcileOrderInput): Promise<void>;

  listReceiverAccounts(): Promise<ReceiverAccountRecord[]>;
  createReceiverAccount(input: CreateReceiverAccountInput): Promise<ReceiverAccountRecord>;
  listReceiverProfiles(): Promise<ReceiverProfileRecord[]>;
  listDeviceReceiverProfiles(
    deviceId: string,
    configuredPayeeVpa: string,
  ): Promise<DiscoveredReceiverProfile[]>;
  createReceiverProfile(input: CreateReceiverProfileInput): Promise<ReceiverProfileRecord>;

  getAdminByEmail(email: string): Promise<AdminRecord | null>;
  createAdmin(email: string, passwordHash: string): Promise<AdminRecord>;
  allowRateLimit(keyHash: string, limit: number, windowSeconds: number, now: Date): Promise<boolean>;
}

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type {
  AdminRecord,
  CreateReceiverAccountInput,
  CreateReceiverProfileInput,
  DevicePaymentLinkInput,
  GatewayRepository,
  ObservationIngestInput,
  PairDeviceInput,
  ReconcileOrderInput,
  ReviewCreditInput,
  SignedDeviceRequestInput,
} from "@/lib/domain/repository";
import type {
  CanonicalObservationV1,
  DeviceRecord,
  DeviceScope,
  NewOrderInput,
  ObservationSource,
  PairingCredentialRecord,
  PaymentOrderRecord,
  ReceiverAccountRecord,
  ReceiverProfileRecord,
  ReviewQueueItem,
} from "@/lib/domain/types";
import {
  createPostgresDatabase,
  type QueryExecutor,
  type TransactionalDatabase,
} from "@/lib/server/db/client";

const ALLOWED_SCOPES = new Set<DeviceScope>(["observations", "links:create", "links:read_own"]);
const MAX_AMOUNT_PAISE = 10_000_000;
const FRESH_OBSERVATION_MS = 5 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 60 * 1000;

export class GatewayRepositoryError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "GatewayRepositoryError";
  }
}

type RawRow = Record<string, unknown>;

function date(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  throw new Error("Invalid database timestamp");
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

function string(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : string(value);
}

function scopes(value: unknown): DeviceScope[] {
  const result = Array.isArray(value) ? value.map(String) : [];
  return result.filter((scope): scope is DeviceScope => ALLOWED_SCOPES.has(scope as DeviceScope));
}

function mapAdmin(row: RawRow): AdminRecord {
  return {
    id: string(row.id),
    email: string(row.email),
    passwordHash: string(row.password_hash),
    createdAt: date(row.created_at),
  };
}

function mapDevice(row: RawRow): DeviceRecord {
  return {
    id: string(row.id),
    name: string(row.name),
    publicKeyJwk: row.public_key_jwk as DeviceRecord["publicKeyJwk"],
    grantedScopes: scopes(row.granted_scopes),
    revokedAt: nullableDate(row.revoked_at),
    createdAt: date(row.created_at),
    lastSeenAt: nullableDate(row.last_seen_at),
  };
}

function mapPairingCredential(row: RawRow): PairingCredentialRecord {
  return {
    id: string(row.id),
    codeHash: string(row.code_hash).trim(),
    expiresAt: date(row.expires_at),
    grantedScopes: scopes(row.granted_scopes),
    usedAt: nullableDate(row.used_at),
    createdAt: date(row.created_at),
  };
}

function mapReceiverAccount(row: RawRow): ReceiverAccountRecord {
  return {
    id: string(row.id),
    label: string(row.label),
    payeeVpa: string(row.payee_vpa),
    verifiedAt: nullableDate(row.verified_at),
    verifiedBy: nullableString(row.verified_by),
  };
}

function mapReceiverProfile(row: RawRow): ReceiverProfileRecord {
  return {
    id: string(row.id),
    receiverAccountId: string(row.receiver_account_id),
    deviceId: string(row.device_id),
    source: string(row.source) as ObservationSource,
    sourceTemplateId: nullableString(row.source_template_id),
    active: Boolean(row.active),
    createdAt: date(row.created_at),
  };
}

function publicTokenKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function tokenHash(secret: string, token: string): string {
  return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}

function encryptToken(secret: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", publicTokenKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decryptToken(secret: string, value: string): string {
  const [ivText, tagText, ciphertextText] = value.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("Stored checkout token is invalid");
  const decipher = createDecipheriv("aes-256-gcm", publicTokenKey(secret), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function mapOrder(row: RawRow, tokenSecret: string): PaymentOrderRecord {
  return {
    id: string(row.id),
    merchantRef: string(row.merchant_ref),
    amountPaise: Number(row.amount_paise),
    currency: "INR",
    description: nullableString(row.description),
    status: string(row.status) as PaymentOrderRecord["status"],
    createdAt: date(row.created_at),
    expiresAt: date(row.expires_at),
    merchantDisplayNameSnapshot: string(row.merchant_display_name_snapshot),
    payeeVpaSnapshot: string(row.payee_vpa_snapshot),
    publicToken: decryptToken(tokenSecret, string(row.public_token_ciphertext)),
    createdByDeviceId: nullableString(row.created_by_device_id),
    paymentSource: nullableString(row.payment_source) as ObservationSource | null,
    bankReconciliationStatus: string(
      row.bank_reconciliation_status,
    ) as PaymentOrderRecord["bankReconciliationStatus"],
    reconciledAt: nullableDate(row.reconciled_at),
    reconciledBy: nullableString(row.reconciled_by),
    officialBankReference: nullableString(row.official_bank_reference),
  };
}

function validateScopes(input: DeviceScope[]): DeviceScope[] {
  if (input.some((scope) => !ALLOWED_SCOPES.has(scope))) throw new GatewayRepositoryError("invalid_scopes");
  return [...new Set(input)].sort();
}

function validateIdempotencyInput(input: NewOrderInput): void {
  if (
    !input.idempotencyScope ||
    input.idempotencyScope.length > 200 ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  ) {
    throw new GatewayRepositoryError("invalid_idempotency_key");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.requestFingerprint))
    throw new GatewayRepositoryError("invalid_request_fingerprint");
}

function validateNewOrderInput(input: NewOrderInput): void {
  if (
    !Number.isSafeInteger(input.amountPaise) ||
    input.amountPaise < 1 ||
    input.amountPaise > MAX_AMOUNT_PAISE
  ) {
    throw new GatewayRepositoryError("invalid_amount");
  }
  if (!/^[A-Z0-9_-]{8,40}$/.test(input.merchantRef))
    throw new GatewayRepositoryError("invalid_merchant_reference");
  if (input.description !== null && input.description.length > 240)
    throw new GatewayRepositoryError("invalid_description");
  const expiresInMs = input.expiresAt.getTime() - Date.now();
  if (expiresInMs < 60_000 || expiresInMs > 24 * 60 * 60 * 1000)
    throw new GatewayRepositoryError("invalid_expiry");
  if (!input.publicToken || input.publicToken.length < 32 || input.publicToken.length > 200) {
    throw new GatewayRepositoryError("invalid_public_token");
  }
}

function validateCanonicalEvent(event: CanonicalObservationV1): Date {
  if (event.schemaVersion !== 1 || !event.eventId || event.eventId.length > 128)
    throw new GatewayRepositoryError("invalid_event");
  if (
    !(event.source === "phonepe" || event.source === "bank_sms") ||
    !(event.eventKind === "incoming_credit" || event.eventKind === "reversal")
  ) {
    throw new GatewayRepositoryError("invalid_event");
  }
  if (
    !Number.isSafeInteger(event.amountPaise) ||
    event.amountPaise < 1 ||
    event.amountPaise > MAX_AMOUNT_PAISE ||
    event.currency !== "INR"
  ) {
    throw new GatewayRepositoryError("invalid_event");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(event.observedAt)) {
    throw new GatewayRepositoryError("invalid_event_time");
  }
  const observedAt = new Date(event.observedAt);
  if (!Number.isFinite(observedAt.getTime())) throw new GatewayRepositoryError("invalid_event_time");
  for (const value of [
    event.merchantRef,
    event.bankRef,
    event.observedPayeeVpa,
    event.receiverProfileId,
    event.sourceTransactionId,
    event.sourceTemplateId,
  ]) {
    if (value !== null && value.length > 255) throw new GatewayRepositoryError("invalid_event");
  }
  return observedAt;
}

function eventFingerprint(event: CanonicalObservationV1): string {
  return createHash("sha256").update(JSON.stringify(event), "utf8").digest("hex");
}

function normalizedBankRef(value: string): string {
  return value.trim().toUpperCase();
}

function maskReference(value: string | null): string | null {
  if (!value) return null;
  return `••••${value.slice(-4)}`;
}

async function one<Row extends RawRow>(
  executor: QueryExecutor,
  sql: string,
  values?: unknown[],
): Promise<Row | null> {
  const result = await executor.query<Row>(sql, values);
  return result.rows[0] ?? null;
}

async function audit(
  executor: QueryExecutor,
  action: string,
  targetType: string,
  targetId: string,
  actorId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_events (actor_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, action, targetType, targetId, JSON.stringify(details)],
  );
}

async function requireActiveDevice(
  executor: QueryExecutor,
  deviceId: string,
  requiredScope: DeviceScope,
  nonce: string,
  nonceExpiresAt: Date,
): Promise<void> {
  const device = await one<RawRow>(
    executor,
    "SELECT id, granted_scopes, revoked_at FROM devices WHERE id = $1 FOR UPDATE",
    [deviceId],
  );
  if (!device) throw new GatewayRepositoryError("unknown_device");
  if (device.revoked_at) throw new GatewayRepositoryError("device_revoked");
  if (!scopes(device.granted_scopes).includes(requiredScope))
    throw new GatewayRepositoryError("device_scope_denied");
  const inserted = await executor.query(
    `INSERT INTO device_request_nonces (device_id, nonce, expires_at)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING nonce`,
    [deviceId, nonce, nonceExpiresAt],
  );
  if (inserted.rowCount === 0) throw new GatewayRepositoryError("replayed_nonce");
  await executor.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [deviceId]);
}

interface ReceiverContext {
  receiverAccountId: string | null;
  payeeVpa: string | null;
  profileFound: boolean;
  sourceApproved: boolean;
  verified: boolean;
  recipientMatches: boolean;
}

async function receiverContext(
  executor: QueryExecutor,
  deviceId: string,
  event: CanonicalObservationV1,
): Promise<ReceiverContext> {
  if (!event.receiverProfileId) {
    return {
      receiverAccountId: null,
      payeeVpa: null,
      profileFound: false,
      sourceApproved: false,
      verified: false,
      recipientMatches: false,
    };
  }
  const profile = await one<RawRow>(
    executor,
    `SELECT p.id, p.receiver_account_id, p.device_id, p.source, p.source_template_id,
            p.active, d.revoked_at, a.payee_vpa, a.verified_at
     FROM receiver_profiles p
     JOIN devices d ON d.id = p.device_id
     JOIN receiver_accounts a ON a.id = p.receiver_account_id
     WHERE p.id = $1 AND p.device_id = $2`,
    [event.receiverProfileId, deviceId],
  );
  if (!profile) {
    return {
      receiverAccountId: null,
      payeeVpa: null,
      profileFound: false,
      sourceApproved: false,
      verified: false,
      recipientMatches: false,
    };
  }
  const profileSource = string(profile.source) as ObservationSource;
  const templateMatches =
    profile.source_template_id === null
      ? event.sourceTemplateId === null
      : string(profile.source_template_id) === event.sourceTemplateId;
  const smsTemplateValid =
    event.source !== "bank_sms" || Boolean(profile.source_template_id && event.sourceTemplateId);
  const sourceApproved =
    profileSource === event.source &&
    Boolean(profile.active) &&
    !profile.revoked_at &&
    templateMatches &&
    smsTemplateValid;
  const payeeVpa = string(profile.payee_vpa);
  const recipientMatches =
    event.observedPayeeVpa === null ||
    event.observedPayeeVpa.trim().toLowerCase() === payeeVpa.trim().toLowerCase();
  return {
    receiverAccountId: string(profile.receiver_account_id),
    payeeVpa,
    profileFound: true,
    sourceApproved,
    verified: Boolean(profile.verified_at),
    recipientMatches,
  };
}

function observationIsFresh(observedAt: Date, receivedAt: Date): boolean {
  const delta = receivedAt.getTime() - observedAt.getTime();
  return delta >= -FUTURE_CLOCK_SKEW_MS && delta <= FRESH_OBSERVATION_MS;
}

export function createGatewayRepository(
  database: TransactionalDatabase,
  tokenSecret = process.env.ORDER_TOKEN_SECRET ?? "",
): GatewayRepository {
  if (tokenSecret.length < 32) throw new Error("ORDER_TOKEN_SECRET must contain at least 32 characters");

  async function insertOrderWithIdempotency(
    executor: QueryExecutor,
    input: NewOrderInput,
  ): Promise<PaymentOrderRecord> {
    validateIdempotencyInput(input);
    const insertedIdempotency = await executor.query(
      `INSERT INTO idempotency_records (scope, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING scope`,
      [input.idempotencyScope, input.idempotencyKey, input.requestFingerprint],
    );

    if (insertedIdempotency.rowCount === 0) {
      const existing = await one<RawRow>(
        executor,
        `SELECT i.request_fingerprint, i.order_id, o.*
         FROM idempotency_records i LEFT JOIN orders o ON o.id = i.order_id
         WHERE i.scope = $1 AND i.idempotency_key = $2 FOR UPDATE OF i`,
        [input.idempotencyScope, input.idempotencyKey],
      );
      if (!existing) throw new GatewayRepositoryError("idempotency_record_missing");
      if (string(existing.request_fingerprint).trim() !== input.requestFingerprint.toLowerCase()) {
        throw new GatewayRepositoryError("idempotency_conflict");
      }
      if (!existing.order_id || !existing.public_token_ciphertext)
        throw new GatewayRepositoryError("idempotency_record_incomplete");
      return mapOrder(existing, tokenSecret);
    }

    validateNewOrderInput(input);
    const receiver = await one<RawRow>(
      executor,
      "SELECT id FROM receiver_accounts WHERE lower(payee_vpa) = lower($1)",
      [input.payeeVpa],
    );
    const insertedOrder = await one<RawRow>(
      executor,
      `INSERT INTO orders (
         merchant_ref, amount_paise, description, created_at, expires_at,
         merchant_display_name_snapshot, payee_vpa_snapshot, receiver_account_id,
         public_token_hash, public_token_ciphertext, created_by_device_id
       ) VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.merchantRef,
        input.amountPaise,
        input.description,
        input.expiresAt,
        input.merchantDisplayName,
        input.payeeVpa,
        receiver?.id ?? null,
        tokenHash(tokenSecret, input.publicToken),
        encryptToken(tokenSecret, input.publicToken),
        input.createdByDeviceId,
      ],
    );
    if (!insertedOrder) throw new Error("Order insert returned no row");
    await executor.query(
      "UPDATE idempotency_records SET order_id = $3 WHERE scope = $1 AND idempotency_key = $2",
      [input.idempotencyScope, input.idempotencyKey, insertedOrder.id],
    );
    await audit(executor, "order_created", "order", string(insertedOrder.id), input.createdByDeviceId, {
      amountPaise: input.amountPaise,
      source: input.createdByDeviceId ? "device" : "merchant",
    });
    return mapOrder(insertedOrder, tokenSecret);
  }

  async function readOrder(sql: string, values: unknown[]): Promise<PaymentOrderRecord | null> {
    const row = await one<RawRow>(database, sql, values);
    if (!row) return null;
    await repository.expireOrderIfDue(string(row.id), new Date());
    const refreshed = await one<RawRow>(database, "SELECT * FROM orders WHERE id = $1", [row.id]);
    return refreshed ? mapOrder(refreshed, tokenSecret) : null;
  }

  const repository: GatewayRepository = {
    async createOrder(input) {
      return database.transaction((executor) => insertOrderWithIdempotency(executor, input));
    },

    async getOrderById(orderId) {
      return readOrder("SELECT * FROM orders WHERE id = $1", [orderId]);
    },

    async getOrderByToken(token) {
      const hash = tokenHash(tokenSecret, token);
      return readOrder("SELECT * FROM orders WHERE public_token_hash = $1", [hash]);
    },

    async expireOrderIfDue(orderId, now) {
      return database.transaction(async (executor) => {
        const updated = await one<RawRow>(
          executor,
          `UPDATE orders SET status = 'expired'
           WHERE id = $1 AND status = 'pending' AND expires_at <= $2
           RETURNING *`,
          [orderId, now],
        );
        if (updated) {
          await audit(executor, "order_expired", "order", orderId, null);
          return mapOrder(updated, tokenSecret);
        }
        const current = await one<RawRow>(executor, "SELECT * FROM orders WHERE id = $1", [orderId]);
        return current ? mapOrder(current, tokenSecret) : null;
      });
    },

    async expireAllOrdersDue(now) {
      return database.transaction(async (executor) => {
        const updated = await executor.query(
          `UPDATE orders SET status = 'expired'
           WHERE status = 'pending' AND expires_at <= $1
           RETURNING id`,
          [now],
        );
        for (const row of updated.rows) await audit(executor, "order_expired", "order", string(row.id), null);
        return updated.rowCount;
      });
    },

    async listRecentOrders(limit) {
      await repository.expireAllOrdersDue(new Date());
      const result = await database.query<RawRow>("SELECT * FROM orders ORDER BY created_at DESC LIMIT $1", [
        Math.max(1, Math.min(100, limit)),
      ]);
      return result.rows.map((row) => mapOrder(row, tokenSecret));
    },

    async createPairingCredential(input) {
      const grantedScopes = validateScopes(input.grantedScopes);
      if (grantedScopes.length === 0) throw new GatewayRepositoryError("invalid_scopes");
      if (!/^[a-f0-9]{64}$/i.test(input.codeHash))
        throw new GatewayRepositoryError("invalid_pairing_code_hash");
      if (input.expiresAt.getTime() <= Date.now()) throw new GatewayRepositoryError("invalid_expiry");
      return database.transaction(async (executor) => {
        const row = await one<RawRow>(
          executor,
          `INSERT INTO pairing_credentials (code_hash, expires_at, granted_scopes, created_by)
           VALUES ($1, $2, $3::text[], $4) RETURNING *`,
          [input.codeHash.toLowerCase(), input.expiresAt, grantedScopes, input.createdBy],
        );
        if (!row) throw new Error("Pairing credential insert returned no row");
        await audit(
          executor,
          "pairing_credential_created",
          "pairing_credential",
          string(row.id),
          input.createdBy,
          {
            grantedScopes,
            expiresAt: input.expiresAt.toISOString(),
          },
        );
        return mapPairingCredential(row);
      });
    },

    async listPairingCredentials() {
      const result = await database.query<RawRow>(
        "SELECT * FROM pairing_credentials ORDER BY created_at DESC LIMIT 100",
      );
      return result.rows.map(mapPairingCredential);
    },

    async pairDevice(input: PairDeviceInput) {
      if (!input.deviceName.trim() || input.deviceName.length > 80)
        throw new GatewayRepositoryError("invalid_device_name");
      if (!/^[A-Za-z0-9_-]{20,120}$/.test(input.nonce)) throw new GatewayRepositoryError("invalid_nonce");
      return database.transaction(async (executor) => {
        const credential = await one<RawRow>(
          executor,
          "SELECT * FROM pairing_credentials WHERE code_hash = $1 FOR UPDATE",
          [input.pairingCodeHash.toLowerCase()],
        );
        if (
          !credential ||
          credential.used_at ||
          date(credential.expires_at).getTime() <= input.pairedAt.getTime()
        ) {
          throw new GatewayRepositoryError("invalid_pairing_code");
        }
        const nonceInsert = await executor.query(
          `INSERT INTO pair_request_nonces (nonce, expires_at)
           VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING nonce`,
          [input.nonce, input.nonceExpiresAt],
        );
        if (nonceInsert.rowCount === 0) throw new GatewayRepositoryError("replayed_nonce");

        const row = await one<RawRow>(
          executor,
          `INSERT INTO devices (id, name, public_key_jwk, granted_scopes, created_at, last_seen_at)
           VALUES ($1, $2, $3::jsonb, $4::text[], $5, $5) RETURNING *`,
          [
            input.deviceId,
            input.deviceName.trim(),
            JSON.stringify(input.publicKeyJwk),
            credential.granted_scopes,
            input.pairedAt,
          ],
        );
        if (!row) throw new Error("Device insert returned no row");
        await executor.query("UPDATE pairing_credentials SET used_at = $2 WHERE id = $1", [
          credential.id,
          input.pairedAt,
        ]);
        await audit(executor, "device_paired", "device", input.deviceId, string(credential.created_by), {
          grantedScopes: scopes(credential.granted_scopes),
        });
        return mapDevice(row);
      });
    },

    async getDevice(deviceId) {
      const row = await one<RawRow>(database, "SELECT * FROM devices WHERE id = $1", [deviceId]);
      return row ? mapDevice(row) : null;
    },

    async listDevices() {
      const result = await database.query<RawRow>("SELECT * FROM devices ORDER BY created_at DESC");
      return result.rows.map(mapDevice);
    },

    async updateDeviceGrants(deviceId, grantedScopes) {
      const requested = validateScopes(grantedScopes);
      return database.transaction(async (executor) => {
        const row = await one<RawRow>(
          executor,
          `UPDATE devices
           SET granted_scopes = ARRAY(
             SELECT DISTINCT scope FROM unnest(granted_scopes || $2::text[]) AS scopes(scope) ORDER BY scope
           )
           WHERE id = $1 AND revoked_at IS NULL
           RETURNING *`,
          [deviceId, requested],
        );
        if (!row) {
          const exists = await one<RawRow>(executor, "SELECT id FROM devices WHERE id = $1", [deviceId]);
          throw new GatewayRepositoryError(exists ? "device_revoked" : "unknown_device");
        }
        await audit(executor, "device_grants_updated", "device", deviceId, null, {
          grantedScopes: scopes(row.granted_scopes),
        });
        return mapDevice(row);
      });
    },

    async revokeDevice(deviceId, actorId) {
      return database.transaction(async (executor) => {
        const row = await one<RawRow>(
          executor,
          `UPDATE devices SET revoked_at = COALESCE(revoked_at, now())
           WHERE id = $1 RETURNING *`,
          [deviceId],
        );
        if (!row) throw new GatewayRepositoryError("unknown_device");
        await audit(executor, "device_revoked", "device", deviceId, actorId);
        return mapDevice(row);
      });
    },

    async acceptSignedDeviceRequest(input: SignedDeviceRequestInput) {
      return database.transaction(async (executor) => {
        await requireActiveDevice(
          executor,
          input.deviceId,
          input.requiredScope,
          input.nonce,
          input.nonceExpiresAt,
        );
      });
    },

    async createDevicePaymentLink(input: DevicePaymentLinkInput) {
      const scopedOrder: NewOrderInput = {
        ...input.order,
        idempotencyScope: `device:${input.deviceId}`,
        createdByDeviceId: input.deviceId,
      };
      return database.transaction(async (executor) => {
        await requireActiveDevice(
          executor,
          input.deviceId,
          "links:create",
          input.nonce,
          input.nonceExpiresAt,
        );
        return insertOrderWithIdempotency(executor, scopedOrder);
      });
    },

    async listDevicePaymentLinks(deviceId, limit) {
      await repository.expireAllOrdersDue(new Date());
      const result = await database.query<RawRow>(
        `SELECT * FROM orders WHERE created_by_device_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [deviceId, Math.max(1, Math.min(100, limit))],
      );
      return result.rows.map((row) => mapOrder(row, tokenSecret));
    },

    async ingestObservation(input: ObservationIngestInput) {
      const observedAt = validateCanonicalEvent(input.event);
      const fingerprint = eventFingerprint(input.event);
      const event = input.event;
      const bankRef = event.bankRef ? normalizedBankRef(event.bankRef) : null;
      if (bankRef && (bankRef.length < 4 || bankRef.length > 128))
        throw new GatewayRepositoryError("invalid_bank_reference");

      return database.transaction(async (executor) => {
        await requireActiveDevice(
          executor,
          input.deviceId,
          "observations",
          input.nonce,
          input.nonceExpiresAt,
        );

        const priorEvent = await one<RawRow>(
          executor,
          "SELECT id, body_hash FROM observation_events WHERE device_id = $1 AND event_id = $2 FOR UPDATE",
          [input.deviceId, event.eventId],
        );
        if (priorEvent) {
          if (string(priorEvent.body_hash).trim() !== fingerprint)
            throw new GatewayRepositoryError("event_id_conflict");
          return { accepted: true as const, duplicate: true };
        }

        const savedEvent = await one<RawRow>(
          executor,
          `INSERT INTO observation_events (
             device_id, event_id, body_hash, schema_version, source, event_kind,
             observed_at, received_at, amount_paise, currency, merchant_ref, bank_ref,
             observed_payee_vpa, receiver_profile_id, source_transaction_id, source_template_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (device_id, event_id) DO NOTHING RETURNING *`,
          [
            input.deviceId,
            event.eventId,
            fingerprint,
            event.schemaVersion,
            event.source,
            event.eventKind,
            observedAt,
            input.receivedAt,
            event.amountPaise,
            event.currency,
            event.merchantRef,
            bankRef,
            event.observedPayeeVpa,
            event.receiverProfileId,
            event.sourceTransactionId,
            event.sourceTemplateId,
          ],
        );
        if (!savedEvent) {
          const racedEvent = await one<RawRow>(
            executor,
            "SELECT id, body_hash FROM observation_events WHERE device_id = $1 AND event_id = $2 FOR UPDATE",
            [input.deviceId, event.eventId],
          );
          if (!racedEvent || string(racedEvent.body_hash).trim() !== fingerprint)
            throw new GatewayRepositoryError("event_id_conflict");
          return { accepted: true as const, duplicate: true };
        }

        const eventRowId = string(savedEvent.id);
        const context = await receiverContext(executor, input.deviceId, event);
        const profileCanIdentifyAccount = context.receiverAccountId !== null;
        const verifiedSource = context.profileFound && context.sourceApproved && context.verified;
        const fresh = observationIsFresh(observedAt, input.receivedAt);
        const candidateOrder = event.merchantRef
          ? await one<RawRow>(executor, "SELECT * FROM orders WHERE merchant_ref = $1 FOR UPDATE", [
              event.merchantRef,
            ])
          : null;

        let bankCredit: RawRow | null = null;
        if (
          profileCanIdentifyAccount &&
          verifiedSource &&
          context.recipientMatches &&
          event.eventKind === "incoming_credit" &&
          bankRef
        ) {
          bankCredit = await one<RawRow>(
            executor,
            `INSERT INTO bank_credits (receiver_account_id, bank_ref, amount_paise, first_seen_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (receiver_account_id, bank_ref) DO NOTHING
             RETURNING *`,
            [context.receiverAccountId, bankRef, event.amountPaise, observedAt],
          );
          if (!bankCredit) {
            bankCredit = await one<RawRow>(
              executor,
              "SELECT * FROM bank_credits WHERE receiver_account_id = $1 AND bank_ref = $2 FOR UPDATE",
              [context.receiverAccountId, bankRef],
            );
          }
        } else if (
          profileCanIdentifyAccount &&
          verifiedSource &&
          context.recipientMatches &&
          event.eventKind === "reversal" &&
          bankRef
        ) {
          bankCredit = await one<RawRow>(
            executor,
            "SELECT * FROM bank_credits WHERE receiver_account_id = $1 AND bank_ref = $2 FOR UPDATE",
            [context.receiverAccountId, bankRef],
          );
        }

        let creditCase = bankCredit
          ? await one<RawRow>(executor, "SELECT * FROM credit_cases WHERE bank_credit_id = $1 FOR UPDATE", [
              bankCredit.id,
            ])
          : null;
        if (!creditCase) {
          creditCase = await one<RawRow>(
            executor,
            `INSERT INTO credit_cases (
               receiver_account_id, bank_credit_id, first_event_id, amount_paise, merchant_ref,
               bank_ref, observed_at, source, event_kind, review_reason, candidate_order_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'awaiting_classification', $10)
             RETURNING *`,
            [
              verifiedSource ? context.receiverAccountId : context.receiverAccountId,
              bankCredit?.id ?? null,
              eventRowId,
              event.amountPaise,
              event.merchantRef,
              bankRef,
              observedAt,
              event.source,
              event.eventKind,
              candidateOrder?.id ?? null,
            ],
          );
        }
        if (!creditCase) throw new Error("Credit review case insert returned no row");
        const creditCaseId = string(creditCase.id);
        await executor.query(
          "INSERT INTO credit_case_events (credit_case_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [creditCaseId, eventRowId],
        );

        if (event.eventKind === "reversal") {
          const linkedMatch = bankCredit
            ? await one<RawRow>(
                executor,
                "SELECT order_id FROM credit_matches WHERE bank_credit_id = $1 FOR UPDATE",
                [bankCredit.id],
              )
            : null;
          if (linkedMatch) {
            await executor.query("UPDATE orders SET status = 'needs_review' WHERE id = $1", [
              linkedMatch.order_id,
            ]);
          }
          await executor.query(
            `UPDATE credit_cases SET review_status = 'open', is_conflicted = true,
               review_reason = 'reversal_requires_review', updated_at = now()
             WHERE id = $1`,
            [creditCaseId],
          );
          await audit(executor, "payment_reversal_observed", "credit_case", creditCaseId, input.deviceId, {
            source: event.source,
            eventId: event.eventId,
            sourceTransactionId: event.sourceTransactionId,
            knownBankCredit: bankCredit !== null,
            linkedOrderId: linkedMatch?.order_id ?? null,
          });
          return { accepted: true as const, duplicate: false };
        }

        const firstEvidence = await one<RawRow>(
          executor,
          `SELECT e.merchant_ref, e.observed_payee_vpa, e.event_kind, e.amount_paise
           FROM credit_case_events ce JOIN observation_events e ON e.id = ce.event_id
           WHERE ce.credit_case_id = $1 AND e.id <> $2
           ORDER BY e.received_at ASC LIMIT 1`,
          [creditCaseId, eventRowId],
        );
        const conflictingEvidence = Boolean(
          firstEvidence &&
            (Number(firstEvidence.amount_paise) !== event.amountPaise ||
              string(firstEvidence.event_kind) !== event.eventKind ||
              (firstEvidence.merchant_ref &&
                event.merchantRef &&
                string(firstEvidence.merchant_ref) !== event.merchantRef) ||
              (firstEvidence.observed_payee_vpa &&
                event.observedPayeeVpa &&
                string(firstEvidence.observed_payee_vpa).trim().toLowerCase() !==
                  event.observedPayeeVpa.trim().toLowerCase())),
        );
        const existingConflict = Boolean(creditCase.is_conflicted);
        let reason = "eligible";
        if (!context.profileFound) reason = "missing_receiver_profile";
        else if (!context.sourceApproved) reason = "unapproved_source_or_template";
        else if (!context.verified) reason = "receiver_account_unverified";
        else if (!context.recipientMatches) reason = "wrong_payee";
        else if (!fresh) reason = "stale_observation";
        else if (!event.merchantRef) reason = "missing_merchant_reference";
        else if (!bankRef) reason = "missing_bank_reference";
        else if (!candidateOrder) reason = "unmatched_merchant_reference";
        else if (candidateOrder && Number(candidateOrder.amount_paise) !== event.amountPaise)
          reason = "amount_mismatch";
        else if (
          candidateOrder &&
          (!candidateOrder.receiver_account_id ||
            string(candidateOrder.receiver_account_id) !== context.receiverAccountId ||
            string(candidateOrder.payee_vpa_snapshot).trim().toLowerCase() !==
              (context.payeeVpa ?? "").trim().toLowerCase())
        )
          reason = "wrong_order_receiver";
        else if (candidateOrder && observedAt.getTime() < date(candidateOrder.created_at).getTime())
          reason = "credit_before_order";
        else if (candidateOrder && observedAt.getTime() > date(candidateOrder.expires_at).getTime())
          reason = "credit_after_expiry";
        else if (
          existingConflict ||
          conflictingEvidence ||
          Number(bankCredit?.amount_paise ?? event.amountPaise) !== event.amountPaise
        )
          reason = "conflicting_credit_evidence";
        else if (candidateOrder && string(candidateOrder.status) === "needs_review")
          reason = "order_already_under_review";
        else if (candidateOrder && string(candidateOrder.status) === "notification_confirmed")
          reason = "order_already_paid";

        const matched = bankCredit
          ? await one<RawRow>(
              executor,
              "SELECT cm.order_id, cm.source FROM credit_matches cm WHERE cm.bank_credit_id = $1 FOR UPDATE",
              [bankCredit.id],
            )
          : null;
        if (matched) {
          const matchedOrder = await one<RawRow>(executor, "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [
            matched.order_id,
          ]);
          const sameMatch =
            matchedOrder &&
            event.eventKind === "incoming_credit" &&
            (!event.merchantRef || event.merchantRef === string(matchedOrder.merchant_ref)) &&
            (!candidateOrder || string(candidateOrder.id) === string(matchedOrder.id)) &&
            Number(bankCredit?.amount_paise) === event.amountPaise &&
            string(matchedOrder.receiver_account_id) === context.receiverAccountId &&
            string(matchedOrder.payee_vpa_snapshot).trim().toLowerCase() ===
              (context.payeeVpa ?? "").trim().toLowerCase() &&
            context.sourceApproved &&
            context.verified &&
            context.recipientMatches &&
            !existingConflict;
          if (sameMatch && !conflictingEvidence) {
            await executor.query(
              "UPDATE credit_cases SET review_status = 'resolved', updated_at = now() WHERE id = $1",
              [creditCaseId],
            );
            return { accepted: true as const, duplicate: false };
          }
          reason = "bank_reference_already_linked_or_conflicting";
          await executor.query("UPDATE orders SET status = 'needs_review' WHERE id = $1", [
            candidateOrder?.id ?? matched.order_id,
          ]);
        }

        const isConflict =
          existingConflict ||
          conflictingEvidence ||
          reason === "wrong_payee" ||
          reason === "wrong_order_receiver" ||
          reason === "bank_reference_already_linked_or_conflicting" ||
          reason === "reversal_requires_review" ||
          reason === "conflicting_credit_evidence";
        const existingCaseMerchantRef = nullableString(creditCase.merchant_ref);
        if (existingCaseMerchantRef && event.merchantRef && existingCaseMerchantRef !== event.merchantRef) {
          reason = "conflicting_credit_evidence";
        }
        const shouldConflict = isConflict || reason === "conflicting_credit_evidence";

        const autoEligible =
          reason === "eligible" &&
          event.eventKind === "incoming_credit" &&
          verifiedSource &&
          context.recipientMatches &&
          fresh &&
          Boolean(event.merchantRef) &&
          Boolean(bankRef) &&
          Boolean(candidateOrder) &&
          Number(candidateOrder?.amount_paise) === event.amountPaise &&
          Boolean(candidateOrder?.receiver_account_id) &&
          string(candidateOrder?.receiver_account_id) === context.receiverAccountId &&
          string(candidateOrder?.payee_vpa_snapshot).trim().toLowerCase() ===
            (context.payeeVpa ?? "").trim().toLowerCase() &&
          observedAt.getTime() >= date(candidateOrder?.created_at).getTime() &&
          observedAt.getTime() <= date(candidateOrder?.expires_at).getTime() &&
          !existingConflict &&
          !conflictingEvidence &&
          !shouldConflict &&
          !matched &&
          bankCredit !== null;

        if (autoEligible && candidateOrder && bankCredit) {
          await executor.query(
            `INSERT INTO credit_matches (bank_credit_id, order_id, matched_at, matched_by, match_type, source)
             VALUES ($1, $2, $3, 'device-observation', 'automatic', $4)`,
            [bankCredit.id, candidateOrder.id, input.receivedAt, event.source],
          );
          await executor.query(
            `UPDATE orders SET status = 'notification_confirmed', payment_source = $2
             WHERE id = $1 AND status IN ('pending', 'expired')`,
            [candidateOrder.id, event.source],
          );
          await executor.query(
            `UPDATE credit_cases SET review_status = 'resolved', review_reason = 'automatically_confirmed',
               candidate_order_id = $2, resolved_order_id = $2, updated_at = now()
             WHERE id = $1`,
            [creditCaseId, candidateOrder.id],
          );
          await audit(
            executor,
            "order_notification_confirmed",
            "order",
            string(candidateOrder.id),
            input.deviceId,
            {
              source: event.source,
              creditCaseId,
              bankReferenceLastFour: bankRef?.slice(-4) ?? null,
            },
          );
          return { accepted: true as const, duplicate: false };
        }

        if (candidateOrder && reason !== "unmatched_merchant_reference") {
          await executor.query(
            `UPDATE orders SET status = 'needs_review'
             WHERE id = $1 AND status IN ('pending', 'expired', 'notification_confirmed')`,
            [candidateOrder.id],
          );
        }
        await executor.query(
          `UPDATE credit_cases
           SET review_status = 'open', review_reason = $2,
               is_conflicted = is_conflicted OR $3,
               candidate_order_id = COALESCE(candidate_order_id, $4),
               merchant_ref = COALESCE(merchant_ref, $5),
               updated_at = now()
           WHERE id = $1`,
          [creditCaseId, reason, shouldConflict, candidateOrder?.id ?? null, event.merchantRef],
        );
        await audit(executor, "payment_observation_reviewed", "credit_case", creditCaseId, input.deviceId, {
          source: event.source,
          reason,
          eventId: event.eventId,
          sourceTransactionId: event.sourceTransactionId,
        });

        return { accepted: true as const, duplicate: false };
      });
    },

    async listReviewQueue(limit) {
      const result = await database.query<RawRow>(
        `SELECT c.id AS credit_id,
                COALESCE(c.candidate_order_id, o.id) AS candidate_order_id,
                COALESCE(c.merchant_ref, first_event.merchant_ref) AS candidate_merchant_ref,
                c.amount_paise,
                c.observed_at,
                c.source,
                COALESCE(c.bank_ref, first_event.bank_ref) AS bank_ref,
                c.review_reason
         FROM credit_cases c
         JOIN observation_events first_event ON first_event.id = c.first_event_id
         LEFT JOIN orders o ON o.merchant_ref = COALESCE(c.merchant_ref, first_event.merchant_ref)
         WHERE c.review_status = 'open'
         ORDER BY c.created_at ASC
         LIMIT $1`,
        [Math.max(1, Math.min(200, limit))],
      );
      return result.rows.map(
        (row) =>
          ({
            creditId: string(row.credit_id),
            candidateOrderId: nullableString(row.candidate_order_id),
            candidateMerchantRef: maskReference(nullableString(row.candidate_merchant_ref)),
            amountPaise: Number(row.amount_paise),
            observedAt: date(row.observed_at),
            source: string(row.source) as ObservationSource,
            maskedBankRef: maskReference(nullableString(row.bank_ref)),
            maskedMerchantRef: maskReference(nullableString(row.candidate_merchant_ref)),
            reason: string(row.review_reason),
          }) satisfies ReviewQueueItem,
      );
    },

    async reviewCredit(input: ReviewCreditInput) {
      const reason = input.reason.trim();
      const evidenceReference = input.evidenceReference.trim();
      const officialBankReference = normalizedBankRef(input.officialBankReference);
      if (reason.length < 5 || reason.length > 1000)
        throw new GatewayRepositoryError("invalid_review_reason");
      if (!evidenceReference || evidenceReference.length > 500)
        throw new GatewayRepositoryError("invalid_evidence_reference");
      if (officialBankReference.length < 4 || officialBankReference.length > 128)
        throw new GatewayRepositoryError("invalid_bank_reference");

      await database.transaction(async (executor) => {
        const creditCase = await one<RawRow>(
          executor,
          `SELECT c.*, a.verified_at
                 , a.payee_vpa
           FROM credit_cases c
           LEFT JOIN receiver_accounts a ON a.id = c.receiver_account_id
           WHERE c.id = $1 FOR UPDATE OF c`,
          [input.creditId],
        );
        if (!creditCase) throw new GatewayRepositoryError("credit_case_not_found");
        if (string(creditCase.event_kind) !== "incoming_credit")
          throw new GatewayRepositoryError("reversal_requires_review");
        if (string(creditCase.review_status) !== "open")
          throw new GatewayRepositoryError("credit_case_already_resolved");
        const hasReversal = await one<RawRow>(
          executor,
          `SELECT 1 AS present FROM credit_case_events ce
           JOIN observation_events e ON e.id = ce.event_id
           WHERE ce.credit_case_id = $1 AND e.event_kind = 'reversal' LIMIT 1`,
          [input.creditId],
        );
        if (hasReversal) throw new GatewayRepositoryError("reversal_requires_review");
        if (!creditCase.receiver_account_id || !creditCase.verified_at) {
          throw new GatewayRepositoryError("receiver_account_unverified");
        }

        const order = await one<RawRow>(executor, "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [
          input.orderId,
        ]);
        if (!order) throw new GatewayRepositoryError("order_not_found");
        if (Number(order.amount_paise) !== Number(creditCase.amount_paise))
          throw new GatewayRepositoryError("credit_amount_mismatch");
        if (
          !order.receiver_account_id ||
          string(order.receiver_account_id) !== string(creditCase.receiver_account_id) ||
          string(order.payee_vpa_snapshot).trim().toLowerCase() !==
            string(creditCase.payee_vpa).trim().toLowerCase()
        ) {
          throw new GatewayRepositoryError("wrong_order_receiver");
        }
        const observedAt = date(creditCase.observed_at);
        if (
          observedAt.getTime() < date(order.created_at).getTime() ||
          observedAt.getTime() > date(order.expires_at).getTime()
        ) {
          throw new GatewayRepositoryError("order_not_payable_at_observation");
        }
        if (
          string(order.status) === "notification_confirmed" &&
          string(order.id) !== nullableString(creditCase.resolved_order_id)
        ) {
          throw new GatewayRepositoryError("order_already_paid");
        }
        const existingMatchForOrder = await one<RawRow>(
          executor,
          "SELECT bank_credit_id FROM credit_matches WHERE order_id = $1 FOR UPDATE",
          [input.orderId],
        );
        if (existingMatchForOrder) throw new GatewayRepositoryError("order_already_paid");

        const caseBankRef = nullableString(creditCase.bank_ref);
        if (caseBankRef && normalizedBankRef(caseBankRef) !== officialBankReference) {
          throw new GatewayRepositoryError("official_reference_mismatch");
        }
        let bankCredit: RawRow | null = creditCase.bank_credit_id
          ? await one<RawRow>(executor, "SELECT * FROM bank_credits WHERE id = $1 FOR UPDATE", [
              creditCase.bank_credit_id,
            ])
          : null;
        if (bankCredit && normalizedBankRef(string(bankCredit.bank_ref)) !== officialBankReference) {
          throw new GatewayRepositoryError("official_reference_mismatch");
        }
        if (!bankCredit) {
          bankCredit = await one<RawRow>(
            executor,
            `INSERT INTO bank_credits (receiver_account_id, bank_ref, amount_paise, first_seen_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (receiver_account_id, bank_ref) DO NOTHING
             RETURNING *`,
            [
              creditCase.receiver_account_id,
              officialBankReference,
              creditCase.amount_paise,
              creditCase.observed_at,
            ],
          );
          if (!bankCredit) {
            bankCredit = await one<RawRow>(
              executor,
              `SELECT * FROM bank_credits
               WHERE receiver_account_id = $1 AND bank_ref = $2 FOR UPDATE`,
              [creditCase.receiver_account_id, officialBankReference],
            );
          }
        }
        if (!bankCredit || Number(bankCredit.amount_paise) !== Number(creditCase.amount_paise)) {
          throw new GatewayRepositoryError("bank_credit_conflict");
        }
        const existingMatch = await one<RawRow>(
          executor,
          "SELECT order_id FROM credit_matches WHERE bank_credit_id = $1 FOR UPDATE",
          [bankCredit.id],
        );
        if (existingMatch) throw new GatewayRepositoryError("bank_reference_already_used");

        await executor.query("UPDATE credit_cases SET bank_credit_id = $2, bank_ref = $3 WHERE id = $1", [
          input.creditId,
          bankCredit.id,
          officialBankReference,
        ]);
        await executor.query(
          `INSERT INTO credit_matches (bank_credit_id, order_id, matched_at, matched_by, match_type, source)
           VALUES ($1, $2, now(), $3, 'manual', $4)`,
          [bankCredit.id, input.orderId, input.actorId, creditCase.source],
        );
        const checkedAt = new Date();
        await executor.query(
          `UPDATE orders SET status = 'notification_confirmed', payment_source = $2,
             bank_reconciliation_status = 'reconciled', reconciled_at = $3,
             reconciled_by = $4, official_bank_reference = $5
           WHERE id = $1`,
          [input.orderId, creditCase.source, checkedAt, input.actorId, officialBankReference],
        );
        await executor.query(
          `INSERT INTO bank_reconciliations (order_id, actor_id, official_bank_reference, reason, checked_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.orderId, input.actorId, officialBankReference, reason, checkedAt],
        );
        await executor.query(
          `UPDATE credit_cases SET review_status = 'resolved', review_reason = 'manually_confirmed',
             resolved_order_id = $2, candidate_order_id = $2, updated_at = now()
           WHERE id = $1`,
          [input.creditId, input.orderId],
        );
        await audit(executor, "credit_manually_confirmed", "credit_case", input.creditId, input.actorId, {
          orderId: input.orderId,
          source: creditCase.source,
          reason,
          evidenceReference,
          officialBankReferenceLastFour: officialBankReference.slice(-4),
        });
        await audit(executor, "bank_reconciled", "order", input.orderId, input.actorId, {
          reason,
          officialBankReferenceLastFour: officialBankReference.slice(-4),
        });
      });
    },

    async reconcileOrder(input: ReconcileOrderInput) {
      const officialBankReference = normalizedBankRef(input.officialBankReference);
      const reason = input.reason.trim();
      if (officialBankReference.length < 4 || officialBankReference.length > 128)
        throw new GatewayRepositoryError("invalid_bank_reference");
      if (reason.length < 5 || reason.length > 1000)
        throw new GatewayRepositoryError("invalid_review_reason");

      await database.transaction(async (executor) => {
        const order = await one<RawRow>(executor, "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [
          input.orderId,
        ]);
        if (!order) throw new GatewayRepositoryError("order_not_found");
        if (string(order.status) !== "notification_confirmed")
          throw new GatewayRepositoryError("order_not_confirmed");
        const match = await one<RawRow>(
          executor,
          `SELECT bc.bank_ref, bc.id
           FROM credit_matches cm JOIN bank_credits bc ON bc.id = cm.bank_credit_id
           WHERE cm.order_id = $1 FOR UPDATE OF bc`,
          [input.orderId],
        );
        if (!match) throw new GatewayRepositoryError("order_not_matched_to_credit");
        if (normalizedBankRef(string(match.bank_ref)) !== officialBankReference) {
          throw new GatewayRepositoryError("official_reference_mismatch");
        }
        const checkedAt = new Date();
        await executor.query(
          `UPDATE orders SET bank_reconciliation_status = 'reconciled', reconciled_at = $2,
             reconciled_by = $3, official_bank_reference = $4
           WHERE id = $1`,
          [input.orderId, checkedAt, input.actorId, officialBankReference],
        );
        await executor.query(
          `INSERT INTO bank_reconciliations (order_id, actor_id, official_bank_reference, reason, checked_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.orderId, input.actorId, officialBankReference, reason, checkedAt],
        );
        await audit(executor, "bank_reconciled", "order", input.orderId, input.actorId, {
          reason,
          officialBankReferenceLastFour: officialBankReference.slice(-4),
        });
      });
    },

    async listReceiverAccounts() {
      const result = await database.query<RawRow>("SELECT * FROM receiver_accounts ORDER BY created_at ASC");
      return result.rows.map(mapReceiverAccount);
    },

    async createReceiverAccount(input: CreateReceiverAccountInput) {
      const label = input.label.trim();
      const payeeVpa = input.payeeVpa.trim().toLowerCase();
      if (!label || label.length > 100) throw new GatewayRepositoryError("invalid_receiver_label");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}@[A-Za-z0-9][A-Za-z0-9.-]{1,80}$/.test(payeeVpa)) {
        throw new GatewayRepositoryError("invalid_payee_vpa");
      }
      if (input.verified && !input.verifiedBy.trim())
        throw new GatewayRepositoryError("verification_actor_required");
      return database.transaction(async (executor) => {
        const row = await one<RawRow>(
          executor,
          `INSERT INTO receiver_accounts (label, payee_vpa, verified_at, verified_by)
           VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END, CASE WHEN $3 THEN $4 ELSE NULL END)
           RETURNING *`,
          [label, payeeVpa, input.verified, input.verifiedBy.trim()],
        );
        if (!row) throw new Error("Receiver account insert returned no row");
        await audit(
          executor,
          "receiver_account_created",
          "receiver_account",
          string(row.id),
          input.verifiedBy || null,
          {
            payeeVpa,
            verified: input.verified,
          },
        );
        return mapReceiverAccount(row);
      });
    },

    async listReceiverProfiles() {
      const result = await database.query<RawRow>(`SELECT * FROM receiver_profiles ORDER BY created_at ASC`);
      return result.rows.map(mapReceiverProfile);
    },

    async createReceiverProfile(input: CreateReceiverProfileInput) {
      if (input.source === "bank_sms" && !input.sourceTemplateId?.trim()) {
        throw new GatewayRepositoryError("validated_sms_template_required");
      }
      if (input.sourceTemplateId && input.sourceTemplateId.length > 100)
        throw new GatewayRepositoryError("invalid_source_template");
      const result = await database.transaction(async (executor) => {
        const device = await one<RawRow>(
          executor,
          "SELECT id, revoked_at FROM devices WHERE id = $1 FOR UPDATE",
          [input.deviceId],
        );
        if (!device) throw new GatewayRepositoryError("unknown_device");
        if (device.revoked_at) throw new GatewayRepositoryError("device_revoked");
        const account = await one<RawRow>(executor, "SELECT id FROM receiver_accounts WHERE id = $1", [
          input.receiverAccountId,
        ]);
        if (!account) throw new GatewayRepositoryError("receiver_account_not_found");
        const row = await one<RawRow>(
          executor,
          `INSERT INTO receiver_profiles (receiver_account_id, device_id, source, source_template_id)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [input.receiverAccountId, input.deviceId, input.source, input.sourceTemplateId?.trim() || null],
        );
        if (!row) throw new Error("Receiver profile insert returned no row");
        await audit(executor, "receiver_profile_created", "receiver_profile", string(row.id), null, {
          receiverAccountId: input.receiverAccountId,
          deviceId: input.deviceId,
          source: input.source,
          sourceTemplateId: input.sourceTemplateId,
        });
        return row;
      });
      return mapReceiverProfile(result);
    },

    async getAdminByEmail(email) {
      const normalizedEmail = email.trim().toLowerCase();
      const row = await one<RawRow>(database, "SELECT * FROM admins WHERE email = $1", [normalizedEmail]);
      return row ? mapAdmin(row) : null;
    },

    async createAdmin(email, passwordHash) {
      const normalizedEmail = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
        throw new GatewayRepositoryError("invalid_admin_email");
      if (passwordHash.length < 20 || passwordHash.length > 512)
        throw new GatewayRepositoryError("invalid_password_hash");
      return database.transaction(async (executor) => {
        await executor.query(
          "SELECT pg_advisory_xact_lock(hashtext('weblaze-payment-gateway-admin-bootstrap'))",
        );
        const existing = await one<RawRow>(executor, "SELECT id FROM admins LIMIT 1 FOR UPDATE");
        if (existing) throw new GatewayRepositoryError("administrator_already_bootstrapped");
        const row = await one<RawRow>(
          executor,
          "INSERT INTO admins (email, password_hash) VALUES ($1, $2) RETURNING *",
          [normalizedEmail, passwordHash],
        );
        if (!row) throw new Error("Administrator insert returned no row");
        await audit(executor, "administrator_bootstrapped", "admin", string(row.id), string(row.id), {
          email: normalizedEmail,
        });
        return mapAdmin(row);
      });
    },

    async allowRateLimit(keyHash, limit, windowSeconds, now) {
      if (!/^[a-f0-9]{64}$/i.test(keyHash)) throw new GatewayRepositoryError("invalid_rate_limit_key");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000)
        throw new GatewayRepositoryError("invalid_rate_limit_limit");
      if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400)
        throw new GatewayRepositoryError("invalid_rate_limit_window");
      const row = await one<RawRow>(
        database,
        `INSERT INTO rate_limit_buckets (key_hash, window_started_at, request_count, expires_at)
         VALUES ($1, $2::timestamptz, 1, $2::timestamptz + make_interval(secs => $3::double precision))
         ON CONFLICT (key_hash) DO UPDATE
         SET window_started_at = CASE
               WHEN rate_limit_buckets.expires_at <= $2::timestamptz THEN $2::timestamptz
               ELSE rate_limit_buckets.window_started_at
             END,
             request_count = CASE
               WHEN rate_limit_buckets.expires_at <= $2::timestamptz THEN 1
               ELSE rate_limit_buckets.request_count + 1
             END,
             expires_at = CASE
               WHEN rate_limit_buckets.expires_at <= $2::timestamptz
                 THEN $2::timestamptz + make_interval(secs => $3::double precision)
               ELSE rate_limit_buckets.expires_at
             END
         RETURNING request_count`,
        [keyHash.toLowerCase(), now, windowSeconds],
      );
      return Number(row?.request_count ?? limit + 1) <= limit;
    },
  };

  return repository;
}

let singletonRepository: GatewayRepository | null = null;

export function getRepository(): GatewayRepository {
  if (singletonRepository) return singletonRepository;
  const connectionString = process.env.DATABASE_URL;
  const tokenSecret = process.env.ORDER_TOKEN_SECRET;
  if (!connectionString) throw new Error("DATABASE_URL is required for gateway database access");
  if (!tokenSecret || tokenSecret.length < 32)
    throw new Error("ORDER_TOKEN_SECRET must contain at least 32 characters");
  singletonRepository = createGatewayRepository(createPostgresDatabase(connectionString), tokenSecret);
  return singletonRepository;
}

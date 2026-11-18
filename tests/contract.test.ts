import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import Module from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import jsQR from "jsqr";
import type { QueryResultRow } from "pg";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import type {
  CanonicalObservationV1,
  DiscoveredReceiverProfile,
  NewOrderInput,
  ObservationSource,
} from "@/lib/domain/types";
import { buildUpiPaymentUri, pairingResponse, paymentLinkResponse } from "@/lib/observer/checkout";
import { makeNewOrderInput } from "@/lib/observer/order-input";
import { deviceRateKey } from "@/lib/observer/rate-limit";
import { optionalMaskedAccountSuffixSchema } from "@/lib/observer/receiver-account";
import { receiverProfilesResponse, sanitizeReceiverDisplayName } from "@/lib/observer/receiver-profiles";
import { makeCanonicalSignatureBytes, verifyDetachedP256 } from "@/lib/observer/signature-core";
import { receiverProfileSourceSchema, sourceTemplateIdSchema } from "@/lib/observer/source-template";
import { isUtcDateTime, isValidIdempotencyKey } from "@/lib/observer/validation";
import { HttpError, requireEmptyRequestBody } from "@/lib/server/api/http";
import type { QueryExecutor, TransactionalDatabase } from "@/lib/server/db/client";
import { runMigrations } from "@/lib/server/db/migrations";
import { createGatewayRepository, GatewayRepositoryError } from "@/lib/server/db/repository";

interface ContractVector {
  headers: Record<string, string>;
  method: string;
  pathAndQuery: string;
  body: string;
  publicKey: { kty: "EC"; crv: "P-256"; x: string; y: string };
  testOnlyPrivateKey: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
  expectedBodySha256: string;
  expectedCanonical: string;
}

let vector: ContractVector;
let alteredBody: { body: string };
let alteredKey: { publicKey: ContractVector["publicKey"] };
let acceptance: {
  createRequest: {
    idempotencyKey: string;
    body: { expiresAtOffsetSeconds: number };
  };
};
let receiverProfileFixture: {
  status: number;
  headers: Record<string, string>;
  body: {
    apiVersion: string;
    gatewayOrigin: string;
    receiverProfiles: DiscoveredReceiverProfile[];
  };
};
let legacy404Fixture: {
  request: { method: string; pathAndQuery: string; contractVersion: string; body: string };
  legacyServerResponse: { status: number; bodyIsIgnored: boolean };
  expectedClientBehavior: string;
};

before(async () => {
  vector = JSON.parse(
    await readFile(path.join(process.cwd(), "contracts/fixtures/v1/signed-observation.json"), "utf8"),
  ) as ContractVector;
  alteredBody = JSON.parse(
    await readFile(path.join(process.cwd(), "contracts/fixtures/v1/altered-body.json"), "utf8"),
  ) as { body: string };
  alteredKey = JSON.parse(
    await readFile(path.join(process.cwd(), "contracts/fixtures/v1/altered-key.json"), "utf8"),
  ) as { publicKey: ContractVector["publicKey"] };
  acceptance = JSON.parse(
    await readFile(path.join(process.cwd(), "contracts/fixtures/v1/payment-link-acceptance.json"), "utf8"),
  );
  receiverProfileFixture = JSON.parse(
    await readFile(path.join(process.cwd(), "contracts/fixtures/v1.0.1/receiver-profiles.json"), "utf8"),
  );
  legacy404Fixture = JSON.parse(
    await readFile(path.join(process.cwd(), "contracts/fixtures/v1.0.1/legacy-server-404.json"), "utf8"),
  );
});

function pgliteExecutor(client: PGliteInterface | Transaction): QueryExecutor {
  return {
    async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) {
      const result = await client.query<Row>(sql, values as never[] | undefined);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rowCount ?? result.rows.length };
    },
  };
}

interface TestInstance {
  pglite: PGlite;
  repository: ReturnType<typeof createGatewayRepository>;
  device: Awaited<ReturnType<ReturnType<typeof createGatewayRepository>["getDevice"]>> extends infer D
    ? NonNullable<D>
    : never;
  profileIds: Record<ObservationSource, string>;
  receiverAccountId: string;
  maskedAccountSuffix: string | null;
  config: {
    origin: string;
    merchantDisplayName: string;
    upiPayeeVpa: string;
    maskedAccountSuffix?: string | null;
  };
}

const instances: TestInstance[] = [];
const tokenSecretA = "synthetic-instance-a-order-token-secret";
const tokenSecretB = "synthetic-instance-b-order-token-secret";

async function createInstance(label: "A" | "B", config: TestInstance["config"]): Promise<TestInstance> {
  const pglite = new PGlite();
  const database: TransactionalDatabase = {
    ...pgliteExecutor(pglite),
    async transaction<Result>(work: (executor: QueryExecutor) => Promise<Result>) {
      return pglite.transaction((transaction) => work(pgliteExecutor(transaction)));
    },
  };
  await runMigrations(database);
  const repository = createGatewayRepository(database, label === "A" ? tokenSecretA : tokenSecretB);
  const receiverAccount = await repository.createReceiverAccount({
    label: `Synthetic ${label} receiving account`,
    payeeVpa: config.upiPayeeVpa,
    maskedAccountSuffix: config.maskedAccountSuffix,
    verifiedBy: `synthetic-${label}-operator`,
    verified: true,
  });
  const pairingCode = `synthetic-pairing-code-${label}-${randomBytes(8).toString("hex")}`;
  const pairingCodeHash = createHash("sha256").update(pairingCode).digest("hex");
  await repository.createPairingCredential({
    codeHash: pairingCodeHash,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    grantedScopes: ["observations", "links:create", "links:read_own"],
    createdBy: `synthetic-${label}-operator`,
  });
  const deviceId = randomUUID();
  const device = await repository.pairDevice({
    pairingCodeHash,
    deviceId,
    deviceName: `Synthetic ${label} phone`,
    publicKeyJwk: (() => {
      const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = pair.publicKey.export({ format: "jwk" });
      if (!jwk.x || !jwk.y) throw new Error("Generated P-256 key did not include its public coordinates.");
      return { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y };
    })(),
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
    pairedAt: new Date(),
  });
  const phonepe = await repository.createReceiverProfile({
    receiverAccountId: receiverAccount.id,
    deviceId,
    source: "phonepe",
    sourceTemplateId: null,
  });
  const bankSms = await repository.createReceiverProfile({
    receiverAccountId: receiverAccount.id,
    deviceId,
    source: "bank_sms",
    sourceTemplateId: "fixture-bank-credit-v1",
  });
  const instance = {
    pglite,
    repository,
    device,
    profileIds: { phonepe: phonepe.id, bank_sms: bankSms.id },
    receiverAccountId: receiverAccount.id,
    maskedAccountSuffix: receiverAccount.maskedAccountSuffix,
    config,
  } satisfies TestInstance;
  instances.push(instance);
  return instance;
}

function makeLinkInput(
  instance: TestInstance,
  input: {
    idempotencyKey: string;
    expiresAt: Date;
    now?: Date;
  },
): NewOrderInput {
  const body = {
    amountPaise: 49950,
    description: "Website deposit",
    expiresAt: input.expiresAt.toISOString(),
  };
  return makeNewOrderInput({
    body,
    config: {
      merchantDisplayName: instance.config.merchantDisplayName,
      upiPayeeVpa: instance.config.upiPayeeVpa,
    },
    idempotencyKey: input.idempotencyKey,
    idempotencyScope: `device:${instance.device.id}`,
    method: "POST",
    path: "/api/v1/payment-links",
    createdByDeviceId: instance.device.id,
    now: input.now,
  });
}

function eventFor(
  instance: TestInstance,
  order: Pick<NewOrderInput, "merchantRef" | "amountPaise">,
  source: ObservationSource,
  eventId: string,
): CanonicalObservationV1 {
  return {
    schemaVersion: 1,
    eventId,
    source,
    eventKind: "incoming_credit",
    observedAt: new Date().toISOString(),
    amountPaise: order.amountPaise,
    currency: "INR",
    merchantRef: order.merchantRef,
    bankRef: "TESTUTR499500000001",
    observedPayeeVpa: instance.config.upiPayeeVpa,
    receiverProfileId: instance.profileIds[source],
    sourceTransactionId: source === "phonepe" ? "fixture-phonepe-credit-01" : "fixture-bank-alert-01",
    sourceTemplateId: source === "bank_sms" ? "fixture-bank-credit-v1" : null,
  };
}

async function observe(instance: TestInstance, event: CanonicalObservationV1) {
  return instance.repository.ingestObservation({
    deviceId: instance.device.id,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
    receivedAt: new Date(),
    event,
  });
}

after(async () => {
  await Promise.all(instances.map((instance) => instance.pglite.close()));
});

test("known P-256 signature vector, altered body/key, and signed idempotency key", async () => {
  const bodyBytes = Buffer.from(vector.body, "utf8");
  assert.equal(createHash("sha256").update(bodyBytes).digest("hex"), vector.expectedBodySha256);
  const canonical = makeCanonicalSignatureBytes({
    method: vector.method,
    pathAndQuery: vector.pathAndQuery,
    timestamp: vector.headers["X-Weblaze-Timestamp"],
    nonce: vector.headers["X-Weblaze-Nonce"],
    body: bodyBytes,
  });
  assert.equal(canonical, vector.expectedCanonical);
  assert.equal(
    verifyDetachedP256({
      publicKeyJwk: vector.publicKey,
      canonicalBytes: canonical,
      signatureBase64Url: vector.headers["X-Weblaze-Signature"],
    }),
    true,
  );

  const alteredCanonical = makeCanonicalSignatureBytes({
    method: vector.method,
    pathAndQuery: vector.pathAndQuery,
    timestamp: vector.headers["X-Weblaze-Timestamp"],
    nonce: vector.headers["X-Weblaze-Nonce"],
    body: Buffer.from(alteredBody.body, "utf8"),
  });
  assert.equal(
    verifyDetachedP256({
      publicKeyJwk: vector.publicKey,
      canonicalBytes: alteredCanonical,
      signatureBase64Url: vector.headers["X-Weblaze-Signature"],
    }),
    false,
  );
  assert.equal(
    verifyDetachedP256({
      publicKeyJwk: alteredKey.publicKey,
      canonicalBytes: canonical,
      signatureBase64Url: vector.headers["X-Weblaze-Signature"],
    }),
    false,
  );

  const idempotencyKey = "link.fixture_2026~01";
  assert.equal(isValidIdempotencyKey(idempotencyKey), true);
  assert.equal(isValidIdempotencyKey("uuid-with-hyphen"), false);
  assert.equal(isValidIdempotencyKey("colon:key"), false);
  const privateKey = createPrivateKey({ key: vector.testOnlyPrivateKey as never, format: "jwk" });
  const linkCanonical = makeCanonicalSignatureBytes({
    method: "POST",
    pathAndQuery: "/api/v1/payment-links",
    timestamp: vector.headers["X-Weblaze-Timestamp"],
    nonce: vector.headers["X-Weblaze-Nonce"],
    idempotencyKey,
    body: Buffer.from('{"amountPaise":49950}', "utf8"),
  });
  const signature = sign("sha256", Buffer.from(linkCanonical, "utf8"), privateKey).toString("base64url");
  assert.equal(
    verifyDetachedP256({
      publicKeyJwk: vector.publicKey,
      canonicalBytes: linkCanonical,
      signatureBase64Url: signature,
    }),
    true,
  );
  const changedKeyCanonical = makeCanonicalSignatureBytes({
    method: "POST",
    pathAndQuery: "/api/v1/payment-links",
    timestamp: vector.headers["X-Weblaze-Timestamp"],
    nonce: vector.headers["X-Weblaze-Nonce"],
    idempotencyKey: `${idempotencyKey}~`,
    body: Buffer.from('{"amountPaise":49950}', "utf8"),
  });
  assert.equal(
    verifyDetachedP256({
      publicKeyJwk: vector.publicKey,
      canonicalBytes: changedKeyCanonical,
      signatureBase64Url: signature,
    }),
    false,
  );
});

test("UTC time validation rejects impossible dates and accepts strict UTC values", () => {
  assert.equal(isUtcDateTime("2028-02-29T23:59:59.123Z"), true);
  assert.equal(isUtcDateTime("2026-11-18T04:30:00Z"), true);
  assert.equal(isUtcDateTime("2026-02-29T10:00:00.000Z"), false);
  assert.equal(isUtcDateTime("2026-99-99T10:00:00.000Z"), false);
  assert.equal(isUtcDateTime("2026-11-18T24:00:00Z"), false);
  assert.equal(isUtcDateTime("2026-11-18T10:00:00+05:30"), false);
});

test("locally generated QR decodes to the same fixed URI used by the payment button", async () => {
  const order = {
    merchantRef: "WZ000000000000000000000001",
    amountPaise: 49950,
    merchantDisplayNameSnapshot: "Example Workshop",
    payeeVpaSnapshot: "fixture.merchant@upi",
  } as const;
  const paymentUri = buildUpiPaymentUri(order);
  const parsed = new URL(paymentUri);
  assert.equal(parsed.protocol, "upi:");
  assert.equal(parsed.hostname, "pay");
  assert.equal(parsed.searchParams.get("pa"), order.payeeVpaSnapshot);
  assert.equal(parsed.searchParams.get("pn"), order.merchantDisplayNameSnapshot);
  assert.equal(parsed.searchParams.get("am"), "499.50");
  assert.equal(parsed.searchParams.get("cu"), "INR");
  assert.equal(parsed.searchParams.get("tr"), order.merchantRef);
  const png = await QRCode.toBuffer(paymentUri, {
    type: "png",
    errorCorrectionLevel: "Q",
    margin: 2,
    width: 320,
    color: { dark: "#17212b", light: "#ffffff" },
  });
  const decodedPixels = PNG.sync.read(png);
  const decoded = jsQR(new Uint8ClampedArray(decodedPixels.data), decodedPixels.width, decodedPixels.height);
  assert.ok(decoded, "generated QR should decode locally");
  assert.equal(decoded.data, paymentUri, "QR contents must equal the UPI button href exactly");
});

test("the shared ₹499.50 acceptance fixture creates one fixed-payee link and confirms that order", async () => {
  const instance = await createInstance("A", {
    origin: "https://gateway-a.example.test",
    merchantDisplayName: "Example Workshop A",
    upiPayeeVpa: "fixture.merchant@upi",
  });
  assert.equal(
    instance.maskedAccountSuffix,
    null,
    "receiver account suffix is optional and defaults to null",
  );
  const now = new Date();
  const expiresAt = new Date(now.getTime() + acceptance.createRequest.body.expiresAtOffsetSeconds * 1000);
  const input = makeLinkInput(instance, {
    idempotencyKey: acceptance.createRequest.idempotencyKey,
    expiresAt,
    now,
  });
  const firstLink = await instance.repository.createDevicePaymentLink({
    order: input,
    deviceId: instance.device.id,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const firstResponse = paymentLinkResponse(firstLink, instance.config.origin);

  const retryInput = makeLinkInput(instance, {
    idempotencyKey: acceptance.createRequest.idempotencyKey,
    expiresAt,
    now: new Date(now.getTime() + 30_000),
  });
  const retryLink = await instance.repository.createDevicePaymentLink({
    order: retryInput,
    deviceId: instance.device.id,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  assert.equal(retryLink.id, firstLink.id, "lost response retry returns the original order");
  assert.equal(paymentLinkResponse(retryLink, instance.config.origin).checkoutUrl, firstResponse.checkoutUrl);
  assert.equal(firstLink.amountPaise, 49950);
  assert.equal(firstLink.description, "Website deposit");
  assert.equal(firstLink.expiresAt.toISOString(), expiresAt.toISOString());
  assert.equal(firstLink.payeeVpaSnapshot, instance.config.upiPayeeVpa);
  assert.equal(firstLink.merchantDisplayNameSnapshot, instance.config.merchantDisplayName);

  const checkoutToken = firstResponse.checkoutUrl.split("/").pop();
  assert.ok(checkoutToken);
  const customerOrder = await instance.repository.getOrderByToken(checkoutToken);
  assert.ok(customerOrder, "opaque checkout token is sufficient for customer checkout lookup");
  assert.equal(customerOrder.description, "Website deposit");
  assert.equal(customerOrder.amountPaise, 49950);
  assert.equal(customerOrder.expiresAt.toISOString(), expiresAt.toISOString());
  const paymentUri = buildUpiPaymentUri(customerOrder);
  assert.equal(new URL(paymentUri).searchParams.get("pa"), instance.config.upiPayeeVpa);

  const matchingSms = eventFor(instance, firstLink, "bank_sms", "evt_fixture_link_credit_01");
  await observe(instance, matchingSms);
  const confirmed = await instance.repository.getOrderById(firstLink.id);
  assert.equal(
    confirmed?.status,
    "notification_confirmed",
    "matching credit confirms this exact order record",
  );
  assert.equal(confirmed?.paymentSource, "bank_sms");

  const corroboratingPhonePe = eventFor(instance, firstLink, "phonepe", "evt_fixture_link_credit_phonepe_01");
  await observe(instance, corroboratingPhonePe);
  const stillOneMatch = await instance.pglite.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM credit_matches WHERE order_id = $1",
    [firstLink.id],
  );
  assert.equal(
    stillOneMatch.rows[0].count,
    1,
    "a second-source report for the same bank credit cannot create another payment",
  );
});

test("omitted and explicit expiry retries return their original order even after expiry", async () => {
  const instance = await createInstance("A", {
    origin: "https://gateway-idempotency.example.test",
    merchantDisplayName: "Example Workshop",
    upiPayeeVpa: "fixture.merchant@upi",
  });

  const defaultBody = { amountPaise: 49950, description: "Website deposit" };
  const defaultFirst = makeNewOrderInput({
    body: defaultBody,
    config: {
      merchantDisplayName: instance.config.merchantDisplayName,
      upiPayeeVpa: instance.config.upiPayeeVpa,
    },
    idempotencyKey: "retry.default.expiry",
    idempotencyScope: `device:${instance.device.id}`,
    method: "POST",
    path: "/api/v1/payment-links",
    createdByDeviceId: instance.device.id,
  });
  const defaultOrder = await instance.repository.createDevicePaymentLink({
    order: defaultFirst,
    deviceId: instance.device.id,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const defaultRetry = makeNewOrderInput({
    body: defaultBody,
    config: {
      merchantDisplayName: instance.config.merchantDisplayName,
      upiPayeeVpa: instance.config.upiPayeeVpa,
    },
    idempotencyKey: "retry.default.expiry",
    idempotencyScope: `device:${instance.device.id}`,
    method: "POST",
    path: "/api/v1/payment-links",
    createdByDeviceId: instance.device.id,
    now: new Date(Date.now() + 30_000),
  });
  const defaultReplay = await instance.repository.createDevicePaymentLink({
    order: defaultRetry,
    deviceId: instance.device.id,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  assert.equal(defaultReplay.id, defaultOrder.id);
  assert.equal(
    defaultReplay.expiresAt.toISOString(),
    defaultOrder.expiresAt.toISOString(),
    "a changed default deadline never replaces the original",
  );

  const explicitExpiry = new Date(Date.now() + 2 * 60_000);
  const explicitBody = {
    amountPaise: 49950,
    description: "Website deposit",
    expiresAt: explicitExpiry.toISOString(),
  };
  const explicitInput = makeLinkInput(instance, {
    idempotencyKey: "retry.explicit.expiry",
    expiresAt: explicitExpiry,
  });
  const explicitOrder = await instance.repository.createDevicePaymentLink({
    order: {
      ...explicitInput,
      ...makeNewOrderInput({
        body: explicitBody,
        config: {
          merchantDisplayName: instance.config.merchantDisplayName,
          upiPayeeVpa: instance.config.upiPayeeVpa,
        },
        idempotencyKey: "retry.explicit.expiry",
        idempotencyScope: `device:${instance.device.id}`,
        method: "POST",
        path: "/api/v1/payment-links",
        createdByDeviceId: instance.device.id,
      }),
    },
    deviceId: instance.device.id,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  await instance.repository.expireOrderIfDue(explicitOrder.id, new Date(explicitExpiry.getTime() + 1000));
  const lateRetryInput = makeNewOrderInput({
    body: explicitBody,
    config: {
      merchantDisplayName: instance.config.merchantDisplayName,
      upiPayeeVpa: instance.config.upiPayeeVpa,
    },
    idempotencyKey: "retry.explicit.expiry",
    idempotencyScope: `device:${instance.device.id}`,
    method: "POST",
    path: "/api/v1/payment-links",
    createdByDeviceId: instance.device.id,
    now: new Date(explicitExpiry.getTime() + 5 * 60_000),
  });
  const lateRetry = await instance.repository.createDevicePaymentLink({
    order: lateRetryInput,
    deviceId: instance.device.id,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  assert.equal(lateRetry.id, explicitOrder.id);
  assert.equal(lateRetry.status, "expired");
});

test("signed device limits use a per-device HMAC database bucket", async () => {
  const instance = await createInstance("A", {
    origin: "https://gateway-rate-limit.example.test",
    merchantDisplayName: "Example Workshop",
    upiPayeeVpa: "fixture.merchant@upi",
  });
  const sharedSecret = "synthetic-session-secret-for-test-only";
  const key = deviceRateKey(instance.device.id, "device-observation-upload", sharedSecret);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key.includes(instance.device.id), false, "the DB key does not expose the device ID");
  const now = new Date();
  assert.equal(await instance.repository.allowRateLimit(key, 1, 60, now), true);
  assert.equal(await instance.repository.allowRateLimit(key, 1, 60, new Date(now.getTime() + 1)), false);
  const otherDeviceKey = deviceRateKey(randomUUID(), "device-observation-upload", sharedSecret);
  assert.equal(
    await instance.repository.allowRateLimit(otherDeviceKey, 1, 60, now),
    true,
    "a separate device has an independent bucket",
  );
  const discoveryKey = deviceRateKey(instance.device.id, "device-receiver-profile-discovery", sharedSecret);
  assert.notEqual(discoveryKey, key, "profile discovery has its own per-device request bucket");
  assert.equal(await instance.repository.allowRateLimit(discoveryKey, 1, 60, now), true);
  assert.equal(
    await instance.repository.allowRateLimit(discoveryKey, 1, 60, new Date(now.getTime() + 1)),
    false,
  );
});

test("receiver-profile discovery filters ownership, grant, active/verified account, and configured payee", async () => {
  const instance = await createInstance("B", {
    origin: "https://gateway-profile-discovery.example.test",
    merchantDisplayName: "Synthetic Discovery Merchant",
    upiPayeeVpa: "discovery.merchant@upi",
    maskedAccountSuffix: "4827",
  });
  assert.equal(instance.maskedAccountSuffix, "4827");
  const otherPayeeAccount = await instance.repository.createReceiverAccount({
    label: "Synthetic unrelated receiver",
    payeeVpa: "other.receiver@upi",
    verifiedBy: "synthetic-operator",
    verified: true,
  });
  const wrongPayeeProfile = await instance.repository.createReceiverProfile({
    receiverAccountId: otherPayeeAccount.id,
    deviceId: instance.device.id,
    source: "bank_sms",
    sourceTemplateId: "wrong-payee-template-v1",
  });
  const inactiveProfile = await instance.repository.createReceiverProfile({
    receiverAccountId: instance.receiverAccountId,
    deviceId: instance.device.id,
    source: "bank_sms",
    sourceTemplateId: "inactive-template-v1",
  });
  const invalidPhonePeProfileId = randomUUID();
  const unsafeLegacySmsProfileId = randomUUID();
  await instance.pglite.query(
    `INSERT INTO receiver_profiles
       (id, receiver_account_id, device_id, source, source_template_id, active, created_at)
     VALUES ($1, $2, $3, 'phonepe', 'phonepe-must-not-have-template', true, now())`,
    [invalidPhonePeProfileId, instance.receiverAccountId, instance.device.id],
  );
  await instance.pglite.query(
    `INSERT INTO receiver_profiles
       (id, receiver_account_id, device_id, source, source_template_id, active, created_at)
     VALUES ($1, $2, $3, 'bank_sms', 'bank-credit-123456', true, now())`,
    [unsafeLegacySmsProfileId, instance.receiverAccountId, instance.device.id],
  );
  await instance.pglite.query("UPDATE receiver_profiles SET active = false WHERE id = $1", [
    inactiveProfile.id,
  ]);

  const otherDeviceCode = `other-device-${randomBytes(8).toString("hex")}`;
  const otherDeviceCodeHash = createHash("sha256").update(otherDeviceCode).digest("hex");
  await instance.repository.createPairingCredential({
    codeHash: otherDeviceCodeHash,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    grantedScopes: ["observations"],
    createdBy: "synthetic-operator",
  });
  const otherDeviceId = randomUUID();
  await instance.repository.pairDevice({
    pairingCodeHash: otherDeviceCodeHash,
    deviceId: otherDeviceId,
    deviceName: "Synthetic second observer",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "other-device-x", y: "other-device-y" },
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
    pairedAt: new Date(),
  });
  const otherDeviceProfile = await instance.repository.createReceiverProfile({
    receiverAccountId: instance.receiverAccountId,
    deviceId: otherDeviceId,
    source: "phonepe",
    sourceTemplateId: null,
  });

  const ownProfiles = await instance.repository.listDeviceReceiverProfiles(
    instance.device.id,
    instance.config.upiPayeeVpa,
  );
  assert.deepEqual(
    ownProfiles.map((profile) => profile.id).sort(),
    [instance.profileIds.phonepe, instance.profileIds.bank_sms].sort(),
    "other payee, inactive, invalid source/template, and other-device profiles are omitted",
  );
  assert.equal(
    ownProfiles.some((profile) => profile.id === wrongPayeeProfile.id),
    false,
  );
  assert.equal(
    ownProfiles.some((profile) => profile.id === inactiveProfile.id),
    false,
  );
  assert.equal(
    ownProfiles.some((profile) => profile.id === invalidPhonePeProfileId),
    false,
  );
  assert.equal(
    ownProfiles.some((profile) => profile.id === unsafeLegacySmsProfileId),
    false,
  );
  const otherDeviceProfiles = await instance.repository.listDeviceReceiverProfiles(
    otherDeviceId,
    instance.config.upiPayeeVpa,
  );
  assert.deepEqual(
    otherDeviceProfiles.map((profile) => profile.id),
    [otherDeviceProfile.id],
  );

  const response = receiverProfilesResponse(instance.config.origin, ownProfiles);
  assert.equal(response.apiVersion, "1.0.0");
  assert.equal(response.gatewayOrigin, instance.config.origin);
  assert.deepEqual(Object.keys(response).sort(), ["apiVersion", "gatewayOrigin", "receiverProfiles"]);
  for (const profile of response.receiverProfiles) {
    assert.deepEqual(Object.keys(profile).sort(), [
      "displayName",
      "id",
      "maskedAccountSuffix",
      "source",
      "sourceTemplateId",
    ]);
    assert.equal(profile.maskedAccountSuffix, "4827", "only the stored last-four hint is returned");
  }
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(instance.config.upiPayeeVpa), false);
  assert.equal(serialized.includes(instance.device.id), false);
  assert.equal(serialized.includes(otherDeviceId), false);
  assert.equal(serialized.includes(instance.receiverAccountId), false);
  assert.equal(serialized.includes("synthetic-operator"), false);
  assert.equal(serialized.includes("discovery.merchant@upi"), false);

  await instance.pglite.query(
    "UPDATE receiver_accounts SET verified_at = NULL, verified_by = NULL WHERE id = $1",
    [instance.receiverAccountId],
  );
  assert.deepEqual(
    await instance.repository.listDeviceReceiverProfiles(instance.device.id, instance.config.upiPayeeVpa),
    [],
    "a profile attached to an unverified account is hidden",
  );
  await instance.pglite.query(
    "UPDATE receiver_accounts SET verified_at = now(), verified_by = 'synthetic-operator' WHERE id = $1",
    [instance.receiverAccountId],
  );

  const noObservationCode = `no-observations-${randomBytes(8).toString("hex")}`;
  const noObservationCodeHash = createHash("sha256").update(noObservationCode).digest("hex");
  await instance.repository.createPairingCredential({
    codeHash: noObservationCodeHash,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    grantedScopes: ["links:read_own"],
    createdBy: "synthetic-operator",
  });
  const noObservationDeviceId = randomUUID();
  await instance.repository.pairDevice({
    pairingCodeHash: noObservationCodeHash,
    deviceId: noObservationDeviceId,
    deviceName: "Synthetic no-observations phone",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "no-observations-x", y: "no-observations-y" },
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
    pairedAt: new Date(),
  });
  await assert.rejects(
    instance.repository.listDeviceReceiverProfiles(noObservationDeviceId, instance.config.upiPayeeVpa),
    (error: unknown) => error instanceof GatewayRepositoryError && error.code === "device_scope_denied",
  );
  await instance.repository.revokeDevice(instance.device.id, "synthetic-operator");
  await assert.rejects(
    instance.repository.listDeviceReceiverProfiles(instance.device.id, instance.config.upiPayeeVpa),
    (error: unknown) => error instanceof GatewayRepositoryError && error.code === "unknown_device",
  );
});

test("contract 1.0.1 matches repository output and tolerates a legacy server 404", async () => {
  assert.equal(receiverProfileFixture.status, 200);
  assert.equal(receiverProfileFixture.headers["Cache-Control"], "no-store, private");
  assert.equal(receiverProfileFixture.body.apiVersion, "1.0.0");
  assert.equal(receiverProfileFixture.body.receiverProfiles.length, 2);
  assert.equal(receiverProfileFixture.body.receiverProfiles[0].maskedAccountSuffix, "4827");

  const instance = await createInstance("A", {
    origin: receiverProfileFixture.body.gatewayOrigin,
    merchantDisplayName: "Example Workshop",
    upiPayeeVpa: "fixture.merchant@upi",
    maskedAccountSuffix: "4827",
  });
  await instance.pglite.query("UPDATE receiver_accounts SET label = $1 WHERE id = $2", [
    "Example Workshop current account",
    instance.receiverAccountId,
  ]);
  await instance.pglite.query("UPDATE receiver_profiles SET id = $1 WHERE id = $2", [
    receiverProfileFixture.body.receiverProfiles[0].id,
    instance.profileIds.phonepe,
  ]);
  await instance.pglite.query("UPDATE receiver_profiles SET id = $1 WHERE id = $2", [
    receiverProfileFixture.body.receiverProfiles[1].id,
    instance.profileIds.bank_sms,
  ]);
  instance.profileIds.phonepe = receiverProfileFixture.body.receiverProfiles[0].id;
  instance.profileIds.bank_sms = receiverProfileFixture.body.receiverProfiles[1].id;
  const repositoryProfiles = await instance.repository.listDeviceReceiverProfiles(
    instance.device.id,
    instance.config.upiPayeeVpa,
  );
  assert.deepEqual(
    receiverProfilesResponse(instance.config.origin, repositoryProfiles),
    receiverProfileFixture.body,
    "actual database query and serializer output must match the published fixture",
  );
  assert.equal(legacy404Fixture.request.pathAndQuery, "/api/v1/receiver-profiles");
  assert.equal(legacy404Fixture.legacyServerResponse.status, 404);
  assert.equal(legacy404Fixture.legacyServerResponse.bodyIsIgnored, true);
  assert.match(legacy404Fixture.expectedClientBehavior, /existing observer flow/);
});

test("receiver-account creation accepts only an optional four-digit suffix and never a full number", async () => {
  const instance = await createInstance("A", {
    origin: "https://gateway-profile-suffix.example.test",
    merchantDisplayName: "Synthetic Suffix Merchant",
    upiPayeeVpa: "suffix.merchant@upi",
  });
  assert.equal(instance.maskedAccountSuffix, null, "omitting a suffix persists null");
  const defaultProfiles = await instance.repository.listDeviceReceiverProfiles(
    instance.device.id,
    instance.config.upiPayeeVpa,
  );
  assert.ok(defaultProfiles.length > 0);
  assert.ok(defaultProfiles.every((profile) => profile.maskedAccountSuffix === null));

  assert.equal(
    optionalMaskedAccountSuffixSchema.parse(""),
    null,
    "a blank optional input normalizes to null",
  );
  assert.equal(optionalMaskedAccountSuffixSchema.parse("4827"), "4827");
  for (const unsafeSuffix of ["123", "12345", "12a4", "1234 5678", "123456789012", "4827\n"]) {
    assert.equal(
      optionalMaskedAccountSuffixSchema.safeParse(unsafeSuffix).success,
      false,
      `schema rejects ${unsafeSuffix}`,
    );
    await assert.rejects(
      instance.repository.createReceiverAccount({
        label: "Synthetic invalid suffix receiver",
        payeeVpa: `invalid${unsafeSuffix.replace(/\D/g, "x")}@upi`,
        maskedAccountSuffix: unsafeSuffix,
        verifiedBy: "synthetic-operator",
        verified: true,
      }),
      (error: unknown) =>
        error instanceof GatewayRepositoryError && error.code === "invalid_masked_account_suffix",
    );
  }

  const persisted = await instance.repository.createReceiverAccount({
    label: "Synthetic suffix receiver",
    payeeVpa: "suffix.receiver@upi",
    maskedAccountSuffix: "4827",
    verifiedBy: "synthetic-operator",
    verified: true,
  });
  assert.equal(persisted.maskedAccountSuffix, "4827");
  const accountRow = await instance.pglite.query<{ masked_account_suffix: string }>(
    "SELECT masked_account_suffix FROM receiver_accounts WHERE id = $1",
    [persisted.id],
  );
  assert.equal(accountRow.rows[0].masked_account_suffix, "4827");
  await assert.rejects(
    instance.pglite.query("UPDATE receiver_accounts SET masked_account_suffix = '12345' WHERE id = $1", [
      persisted.id,
    ]),
    /receiver_accounts_masked_account_suffix_check/,
    "the migration CHECK constraint rejects values outside the four-digit format",
  );
});

test("receiver-profile labels allow short Unicode text and replace sensitive or malformed values", () => {
  assert.equal(sanitizeReceiverDisplayName("  Café   &   Main   account  "), "Café & Main account");
  for (const unsafeLabel of [
    "Account 1234 5678 9012",
    "Merchant 12345678",
    "merchant@upi",
    "owner@example.test",
    "Main\nAccount",
    "Hidden\u200bIdentifier",
    "Account #42",
  ]) {
    assert.equal(sanitizeReceiverDisplayName(unsafeLabel), "Verified receiving account");
    const response = receiverProfilesResponse("https://gateway.operator.example", [
      {
        id: randomUUID(),
        source: "phonepe",
        displayName: unsafeLabel,
        maskedAccountSuffix: null,
        sourceTemplateId: null,
      },
    ]);
    assert.equal(response.receiverProfiles[0].displayName, "Verified receiving account");
    assert.equal(
      JSON.stringify(response).includes(unsafeLabel),
      false,
      "unsafe label never appears in device response",
    );
  }
  const unsafeSuffixResponse = receiverProfilesResponse("https://gateway.operator.example", [
    {
      id: randomUUID(),
      source: "phonepe",
      displayName: "Main receiving account",
      maskedAccountSuffix: "123456789012",
      sourceTemplateId: null,
    },
  ]);
  assert.equal(unsafeSuffixResponse.receiverProfiles[0].maskedAccountSuffix, null);
  assert.equal(JSON.stringify(unsafeSuffixResponse).includes("123456789012"), false);
});

test("source template IDs use non-sensitive keys for receiver profiles", async () => {
  assert.equal(sourceTemplateIdSchema.safeParse("Bank-credit:V1").success, true);
  assert.equal(sourceTemplateIdSchema.safeParse("A_1.v2-key:bank").success, true);
  for (const unsafeKey of [
    "123-bank-credit",
    "bank@upi",
    "bank template",
    "bank-credit-1234",
    "bank-credit-1234567890",
    "bank-123-456-7890",
    "account-12-34-56-78",
    "bank-credit\n",
    "a".repeat(65),
  ]) {
    assert.equal(sourceTemplateIdSchema.safeParse(unsafeKey).success, false, unsafeKey);
  }
  assert.equal(
    receiverProfileSourceSchema.safeParse({ source: "bank_sms", sourceTemplateId: "Bank-credit:V1" }).success,
    true,
  );
  assert.equal(
    receiverProfileSourceSchema.safeParse({ source: "bank_sms", sourceTemplateId: null }).success,
    false,
  );
  assert.equal(
    receiverProfileSourceSchema.safeParse({ source: "phonepe", sourceTemplateId: "PhonePe:V1" }).success,
    false,
  );

  const instance = await createInstance("A", {
    origin: "https://gateway-source-key.example.test",
    merchantDisplayName: "Synthetic Source Key Merchant",
    upiPayeeVpa: "source.key@upi",
  });
  await assert.rejects(
    instance.repository.createReceiverProfile({
      receiverAccountId: instance.receiverAccountId,
      deviceId: instance.device.id,
      source: "bank_sms",
      sourceTemplateId: "bank-credit-1234",
    }),
    (error: unknown) => error instanceof GatewayRepositoryError && error.code === "invalid_source_template",
  );
  await assert.rejects(
    instance.repository.createReceiverProfile({
      receiverAccountId: instance.receiverAccountId,
      deviceId: instance.device.id,
      source: "phonepe",
      sourceTemplateId: "PhonePe:V1",
    }),
    (error: unknown) => error instanceof GatewayRepositoryError && error.code === "invalid_source_template",
  );
  const unsafeLegacyResponse = receiverProfilesResponse("https://gateway.operator.example", [
    {
      id: randomUUID(),
      source: "bank_sms",
      displayName: "Main receiving account",
      maskedAccountSuffix: null,
      sourceTemplateId: "bank-123-456-7890",
    },
  ]);
  assert.deepEqual(unsafeLegacyResponse.receiverProfiles, []);
  assert.equal(JSON.stringify(unsafeLegacyResponse).includes("bank-123-456-7890"), false);
});

test("receiver-profile signed GET rejects any body before authentication with bounded size handling", async () => {
  await assert.doesNotReject(() => requireEmptyRequestBody({ body: null } as Request));
  await assert.rejects(
    requireEmptyRequestBody({
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      headers: new Headers({ "content-length": "0" }),
    } as Request),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
  await assert.rejects(
    requireEmptyRequestBody({
      body: new ReadableStream(),
      headers: new Headers({ "content-length": String(32 * 1024 + 1) }),
    } as Request),
    (error: unknown) => error instanceof HttpError && error.status === 413,
  );
});

test("receiver-profile route rejects a nonempty body before auth and returns the fixture without caching", async () => {
  const instance = await createInstance("B", {
    origin: receiverProfileFixture.body.gatewayOrigin,
    merchantDisplayName: "Example Workshop",
    upiPayeeVpa: "fixture.merchant@upi",
    maskedAccountSuffix: "4827",
  });
  await instance.pglite.query("UPDATE receiver_accounts SET label = $1 WHERE id = $2", [
    "Example Workshop current account",
    instance.receiverAccountId,
  ]);
  await instance.pglite.query("UPDATE receiver_profiles SET id = $1 WHERE id = $2", [
    receiverProfileFixture.body.receiverProfiles[0].id,
    instance.profileIds.phonepe,
  ]);
  await instance.pglite.query("UPDATE receiver_profiles SET id = $1 WHERE id = $2", [
    receiverProfileFixture.body.receiverProfiles[1].id,
    instance.profileIds.bank_sms,
  ]);

  const moduleLoader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  let authenticationCalls = 0;
  let rateLimitCall: unknown;
  moduleLoader._load = ((request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "@/lib/config") {
      return {
        loadGatewayConfig: () => ({
          gatewayPublicOrigin: instance.config.origin,
          upiPayeeVpa: instance.config.upiPayeeVpa,
        }),
      };
    }
    if (request === "@/lib/server/api/rate-limit") {
      return {
        enforceDeviceRateLimit: async (...args: unknown[]) => {
          rateLimitCall = args;
        },
      };
    }
    if (request === "@/lib/server/api/signature") {
      const signatureModule = originalLoad.call(Module, request, parent, isMain) as Record<string, unknown>;
      return {
        ...signatureModule,
        authenticateSignedDevice: async () => {
          authenticationCalls += 1;
          return { device: { id: instance.device.id } };
        },
      };
    }
    if (request === "@/lib/server/db/repository") {
      return { getRepository: async () => instance.repository };
    }
    return originalLoad.call(Module, request, parent, isMain);
  }) as typeof moduleLoader._load;
  try {
    const route = await import("../src/app/api/v1/receiver-profiles/route");
    const invalidRequest = {
      headers: new Headers({
        "X-Weblaze-Contract-Version": "1",
        "content-length": "4",
      }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data"));
          controller.close();
        },
      }),
    } as Request;
    const invalidResponse = await route.GET(invalidRequest);
    assert.equal(invalidResponse.status, 400);
    assert.equal((await invalidResponse.json()).error.code, "invalid_request");
    assert.equal(authenticationCalls, 0, "nonempty GET bodies are rejected before device authentication");

    const validResponse = await route.GET({
      url: `${instance.config.origin}/api/v1/receiver-profiles`,
      headers: new Headers({
        "X-Weblaze-Contract-Version": "1",
        host: new URL(instance.config.origin).host,
      }),
      body: null,
    } as Request);
    assert.equal(validResponse.status, 200);
    assert.equal(validResponse.headers.get("cache-control"), "no-store, private");
    assert.deepEqual(await validResponse.json(), receiverProfileFixture.body);
    assert.equal(authenticationCalls, 1);
    assert.deepEqual(rateLimitCall, [instance.device.id, "device-receiver-profile-discovery", 120, 60]);
  } finally {
    moduleLoader._load = originalLoad;
  }
});

test("two synthetic installations isolate settings, checkout links, pairing, and observed matches", async () => {
  const a = await createInstance("A", {
    origin: "https://gateway-a.example.test",
    merchantDisplayName: "Workshop A",
    upiPayeeVpa: "workshop.a@upi",
  });
  const b = await createInstance("B", {
    origin: "https://gateway-b.example.test",
    merchantDisplayName: "Workshop B",
    upiPayeeVpa: "workshop.b@upi",
  });
  const pairedA = pairingResponse({
    gatewayOrigin: a.config.origin,
    merchantDisplayName: a.config.merchantDisplayName,
    payeeVpa: a.config.upiPayeeVpa,
    device: a.device,
  });
  const pairedB = pairingResponse({
    gatewayOrigin: b.config.origin,
    merchantDisplayName: b.config.merchantDisplayName,
    payeeVpa: b.config.upiPayeeVpa,
    device: b.device,
  });
  assert.equal(pairedA.gatewayOrigin, a.config.origin);
  assert.equal(pairedA.merchantDisplayName, a.config.merchantDisplayName);
  assert.equal(pairedA.payeeVpa, a.config.upiPayeeVpa);
  assert.equal(pairedB.gatewayOrigin, b.config.origin);
  assert.equal(pairedB.merchantDisplayName, b.config.merchantDisplayName);
  assert.equal(pairedB.payeeVpa, b.config.upiPayeeVpa);

  const aInput = makeNewOrderInput({
    body: { amountPaise: 24900, description: null },
    config: { merchantDisplayName: a.config.merchantDisplayName, upiPayeeVpa: a.config.upiPayeeVpa },
    idempotencyKey: "install.a.order.24900",
    idempotencyScope: `device:${a.device.id}`,
    method: "POST",
    path: "/api/v1/payment-links",
    createdByDeviceId: a.device.id,
  });
  const bInput = makeNewOrderInput({
    body: { amountPaise: 24900, description: null },
    config: { merchantDisplayName: b.config.merchantDisplayName, upiPayeeVpa: b.config.upiPayeeVpa },
    idempotencyKey: "install.b.order.24900",
    idempotencyScope: `device:${b.device.id}`,
    method: "POST",
    path: "/api/v1/payment-links",
    createdByDeviceId: b.device.id,
  });
  const orderA = await a.repository.createDevicePaymentLink({
    order: aInput,
    deviceId: a.device.id,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const orderB = await b.repository.createDevicePaymentLink({
    order: bInput,
    deviceId: b.device.id,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const linkA = paymentLinkResponse(orderA, a.config.origin);
  const linkB = paymentLinkResponse(orderB, b.config.origin);
  assert.ok(linkA.checkoutUrl.startsWith(`${a.config.origin}/checkout/`));
  assert.ok(linkB.checkoutUrl.startsWith(`${b.config.origin}/checkout/`));
  assert.equal(new URL(buildUpiPaymentUri(orderA)).searchParams.get("pa"), a.config.upiPayeeVpa);
  assert.equal(new URL(buildUpiPaymentUri(orderA)).searchParams.get("pn"), a.config.merchantDisplayName);
  assert.equal(new URL(buildUpiPaymentUri(orderB)).searchParams.get("pa"), b.config.upiPayeeVpa);
  assert.equal(new URL(buildUpiPaymentUri(orderB)).searchParams.get("pn"), b.config.merchantDisplayName);

  await observe(a, eventFor(a, orderA, "phonepe", "evt_install_a_001"));
  await observe(b, eventFor(b, orderB, "phonepe", "evt_install_b_001"));
  assert.equal((await a.repository.getOrderById(orderA.id))?.status, "notification_confirmed");
  assert.equal((await b.repository.getOrderById(orderB.id))?.status, "notification_confirmed");

  await assert.rejects(
    () =>
      b.repository.ingestObservation({
        deviceId: a.device.id,
        nonce: randomBytes(16).toString("base64url"),
        nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
        receivedAt: new Date(),
        event: eventFor(b, orderB, "phonepe", "evt_cross_instance_denied"),
      }),
    (error: unknown) => error instanceof GatewayRepositoryError && error.code === "unknown_device",
  );
  assert.equal(
    await b.repository.getOrderByToken(orderA.publicToken),
    null,
    "instance B cannot resolve instance A's checkout token",
  );
});

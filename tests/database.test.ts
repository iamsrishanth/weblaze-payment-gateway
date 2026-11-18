import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { GatewayRepository } from "@/lib/domain/repository";
import type { CanonicalObservationV1, NewOrderInput, ObservationSource } from "@/lib/domain/types";
import type { QueryExecutor, TransactionalDatabase } from "@/lib/server/db/client";
import { runMigrations } from "@/lib/server/db/migrations";
import { createGatewayRepository, GatewayRepositoryError } from "@/lib/server/db/repository";

const SECRET = "test-only-order-token-secret-32-chars";
const PAYEE = "merchant-test@upi";

function pgliteExecutor(client: PGliteInterface | Transaction): QueryExecutor {
  return {
    async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) {
      const result = await client.query<Row>(sql, values as never[] | undefined);
      return {
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rowCount ?? result.rows.length,
      };
    },
  };
}

interface Fixture {
  pglite: PGlite;
  repository: GatewayRepository;
  deviceId: string;
  phonepeProfileId: string;
  smsProfileId: string;
  receiverAccountId: string;
}

let fixture: Fixture;

async function setup(): Promise<Fixture> {
  const pglite = new PGlite();
  const database: TransactionalDatabase = {
    ...pgliteExecutor(pglite),
    async transaction<Result>(work: (executor: QueryExecutor) => Promise<Result>) {
      return pglite.transaction((transaction) => work(pgliteExecutor(transaction)));
    },
  };
  await runMigrations(database);
  const repository = createGatewayRepository(database, SECRET);

  const receiverAccount = await repository.createReceiverAccount({
    label: "Synthetic merchant receiver",
    payeeVpa: PAYEE,
    verifiedBy: "test-operator",
    verified: true,
  });
  const pairingCode = "synthetic-pairing-code-0123456789";
  const pairingCodeHash = createHash("sha256").update(pairingCode).digest("hex");
  const pairing = await repository.createPairingCredential({
    codeHash: pairingCodeHash,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    grantedScopes: ["observations", "links:create", "links:read_own"],
    createdBy: "test-operator",
  });
  assert.ok(pairing.id);
  const deviceId = randomUUID();
  const nonce = randomBytes(16).toString("base64url");
  await repository.pairDevice({
    pairingCodeHash,
    deviceId,
    deviceName: "Synthetic observer phone",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "test-x-coordinate", y: "test-y-coordinate" },
    nonce,
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
    pairedAt: new Date(),
  });
  const phonepeProfile = await repository.createReceiverProfile({
    receiverAccountId: receiverAccount.id,
    deviceId,
    source: "phonepe",
    sourceTemplateId: null,
  });
  const smsProfile = await repository.createReceiverProfile({
    receiverAccountId: receiverAccount.id,
    deviceId,
    source: "bank_sms",
    sourceTemplateId: "bank-credit-template-v1",
  });
  return {
    pglite,
    repository,
    deviceId,
    phonepeProfileId: phonepeProfile.id,
    smsProfileId: smsProfile.id,
    receiverAccountId: receiverAccount.id,
  };
}

before(async () => {
  fixture = await setup();
});

after(async () => {
  await fixture?.pglite.close();
});

function orderInput(options: Partial<NewOrderInput> = {}): NewOrderInput {
  return {
    amountPaise: 24_900,
    description: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    merchantDisplayName: "Synthetic Shop",
    payeeVpa: PAYEE,
    idempotencyScope: `merchant:${randomUUID()}`,
    idempotencyKey: randomUUID(),
    requestFingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
    createdByDeviceId: null,
    merchantRef: `WZ${randomBytes(12).toString("hex").toUpperCase()}`,
    publicToken: randomBytes(32).toString("base64url"),
    ...options,
  };
}

async function observe(
  event: CanonicalObservationV1,
  source: ObservationSource = event.source,
  receivedAt = new Date(),
) {
  return fixture.repository.ingestObservation({
    deviceId: fixture.deviceId,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
    receivedAt,
    event: { ...event, source },
  });
}

function eventFor(
  order: NewOrderInput,
  options: Partial<CanonicalObservationV1> = {},
): CanonicalObservationV1 {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    source: "phonepe",
    eventKind: "incoming_credit",
    observedAt: new Date().toISOString(),
    amountPaise: order.amountPaise,
    currency: "INR",
    merchantRef: order.merchantRef,
    bankRef: `UTR${randomBytes(8).toString("hex").toUpperCase()}`,
    observedPayeeVpa: PAYEE,
    receiverProfileId: fixture.phonepeProfileId,
    sourceTransactionId: `PHONEPE-${randomUUID()}`,
    sourceTemplateId: null,
    ...options,
  };
}

async function expectRepoCode(work: () => Promise<unknown>, code: string) {
  await assert.rejects(
    work,
    (error: unknown) => error instanceof GatewayRepositoryError && error.code === code,
  );
}

test("one-time administrator bootstrap stores a verified password hash", async () => {
  const password = "synthetic-bootstrap-password-2026";
  const created = await fixture.repository.createAdmin(
    "operator@copper-finch.studio",
    hashPassword(password),
  );

  assert.equal(created.email, "operator@copper-finch.studio");
  assert.notEqual(created.passwordHash, password);
  assert.equal(verifyPassword(password, created.passwordHash), true);
  const stored = await fixture.repository.getAdminByEmail(created.email);
  assert.ok(stored);
  assert.equal(stored.id, created.id);
  assert.equal(stored.passwordHash, created.passwordHash);
  await expectRepoCode(
    () => fixture.repository.createAdmin("second@copper-finch.studio", hashPassword(password)),
    "administrator_already_bootstrapped",
  );
});

test("migrations, exact paise matching, reference uniqueness, and cross-source evidence", async (t) => {
  const rowSecurity = await fixture.pglite.query<{ protectedTables: number; unprotectedTables: number }>(`
    SELECT
      count(*) FILTER (WHERE relrowsecurity)::integer AS "protectedTables",
      count(*) FILTER (WHERE NOT relrowsecurity)::integer AS "unprotectedTables"
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  `);
  assert.equal(rowSecurity.rows[0]?.protectedTables, 18);
  assert.equal(rowSecurity.rows[0]?.unprotectedTables, 0);

  const sourceOrder = orderInput({ idempotencyScope: "merchant:paise", idempotencyKey: "paise-test" });
  const first = await fixture.repository.createOrder(sourceOrder);
  const secondInput = orderInput({
    idempotencyScope: "merchant:paise-second",
    idempotencyKey: "paise-test-2",
  });
  const second = await fixture.repository.createOrder(secondInput);
  assert.equal(first.amountPaise, 24_900);
  assert.equal(second.amountPaise, 24_900);

  const referenceFreeEvent = eventFor(sourceOrder, { eventId: "reference-free", merchantRef: null });
  await observe(referenceFreeEvent);
  const maximumEventId = eventFor(sourceOrder, {
    eventId: "e".repeat(128),
    merchantRef: null,
    bankRef: null,
  });
  assert.deepEqual(await observe(maximumEventId), { accepted: true, duplicate: false });
  await expectRepoCode(() => observe({ ...maximumEventId, eventId: "e".repeat(129) }), "invalid_event");
  assert.equal((await fixture.repository.getOrderById(first.id))?.status, "pending");
  assert.equal((await fixture.repository.getOrderById(second.id))?.status, "pending");

  const matchedEvent = eventFor(sourceOrder, { eventId: "phonepe-matched-credit" });
  await observe(matchedEvent);
  assert.equal((await fixture.repository.getOrderById(first.id))?.status, "notification_confirmed");
  assert.equal((await fixture.repository.getOrderById(second.id))?.status, "pending");

  const corroboration = eventFor(sourceOrder, {
    eventId: "sms-corroboration-no-merchant-ref",
    source: "bank_sms",
    merchantRef: null,
    bankRef: matchedEvent.bankRef,
    receiverProfileId: fixture.smsProfileId,
    sourceTransactionId: null,
    sourceTemplateId: "bank-credit-template-v1",
  });
  await observe(corroboration, "bank_sms");
  assert.equal((await fixture.repository.getOrderById(first.id))?.status, "notification_confirmed");
  assert.equal((await fixture.repository.getOrderById(second.id))?.status, "pending");
  assert.deepEqual(
    await observe(matchedEvent),
    { accepted: true, duplicate: true },
    "a fresh signed retry after a lost response is acknowledged",
  );
  await expectRepoCode(
    () => observe({ ...matchedEvent, amountPaise: matchedEvent.amountPaise + 1 }),
    "event_id_conflict",
  );

  const rows = await fixture.pglite.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM bank_credits",
  );
  assert.equal(
    rows.rows[0].count,
    2,
    "reference-free and matched transfers keep separate bank-credit identities",
  );
  const evidence = await fixture.pglite.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM credit_case_events",
  );
  assert.equal(evidence.rows[0].count, 4, "separate source events remain attached as evidence");
  await t.test("reference-free credit remains in review", async () => {
    const queue = await fixture.repository.listReviewQueue(20);
    assert.ok(queue.some((item) => item.reason === "missing_merchant_reference"));
  });
});

test("idempotency returns the original link after expiry and conflicts on changed payload", async () => {
  const input = orderInput({ idempotencyScope: "merchant:idempotency", idempotencyKey: "same-key" });
  const original = await fixture.repository.createOrder(input);
  const retry = await fixture.repository.createOrder({
    ...input,
    expiresAt: new Date(0),
    publicToken: "too-short-for-a-new-order",
    merchantRef: "not-a-new-order-ref",
  });
  assert.equal(retry.id, original.id);
  assert.equal(retry.publicToken, original.publicToken);

  await expectRepoCode(
    () =>
      fixture.repository.createOrder({
        ...input,
        requestFingerprint: createHash("sha256").update("different payload").digest("hex"),
      }),
    "idempotency_conflict",
  );

  const raceInput = orderInput({ idempotencyScope: "merchant:race", idempotencyKey: "race-key" });
  const [raceA, raceB] = await Promise.all([
    fixture.repository.createOrder(raceInput),
    fixture.repository.createOrder({ ...raceInput, publicToken: randomBytes(32).toString("base64url") }),
  ]);
  assert.equal(raceA.id, raceB.id);
});

test("same bank reference cannot confirm two different orders", async () => {
  const one = orderInput({ idempotencyScope: "merchant:double-1", idempotencyKey: "double-1" });
  const two = orderInput({ idempotencyScope: "merchant:double-2", idempotencyKey: "double-2" });
  const orderOne = await fixture.repository.createOrder(one);
  const orderTwo = await fixture.repository.createOrder(two);
  const sharedBankRef = `UTR${randomBytes(8).toString("hex").toUpperCase()}`;

  await observe(eventFor(one, { eventId: "first-use-bank-ref", bankRef: sharedBankRef }));
  await observe(eventFor(two, { eventId: "second-use-bank-ref", bankRef: sharedBankRef }));

  assert.equal((await fixture.repository.getOrderById(orderOne.id))?.status, "notification_confirmed");
  assert.equal((await fixture.repository.getOrderById(orderTwo.id))?.status, "needs_review");
  const matches = await fixture.pglite.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM credit_matches cm
     JOIN bank_credits bc ON bc.id = cm.bank_credit_id
     WHERE bc.receiver_account_id = $1 AND bc.bank_ref = $2`,
    [fixture.receiverAccountId, sharedBankRef],
  );
  assert.equal(matches.rows[0].count, 1);
});

test("wrong payee, unknown reversal, and matched reversal are safely reviewed", async () => {
  const wrongRecipientInput = orderInput({
    idempotencyScope: "merchant:wrong-recipient",
    idempotencyKey: "wrong-recipient",
  });
  const wrongRecipientOrder = await fixture.repository.createOrder(wrongRecipientInput);
  const wrongRecipient = eventFor(wrongRecipientInput, {
    eventId: "wrong-recipient-credit",
    observedPayeeVpa: "someone-else@upi",
  });
  await observe(wrongRecipient);
  assert.equal((await fixture.repository.getOrderById(wrongRecipientOrder.id))?.status, "needs_review");
  const afterWrongRecipient = await fixture.pglite.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM bank_credits",
  );
  assert.equal(
    afterWrongRecipient.rows[0].count,
    3,
    "wrong-payee evidence cannot create an underlying bank-credit identity",
  );

  const unknownReversalInput = orderInput({
    idempotencyScope: "merchant:unknown-reversal",
    idempotencyKey: "unknown-reversal",
  });
  const unknownReversalOrder = await fixture.repository.createOrder(unknownReversalInput);
  await observe(
    eventFor(unknownReversalInput, {
      eventId: "unknown-reversal-event",
      eventKind: "reversal",
      bankRef: `UTR${randomBytes(8).toString("hex").toUpperCase()}`,
    }),
  );
  assert.equal(
    (await fixture.repository.getOrderById(unknownReversalOrder.id))?.status,
    "pending",
    "unknown reversal does not alter its merchantRef candidate",
  );

  const matchedInput = orderInput({
    idempotencyScope: "merchant:matched-reversal",
    idempotencyKey: "matched-reversal",
  });
  const matchedOrder = await fixture.repository.createOrder(matchedInput);
  const incoming = eventFor(matchedInput, { eventId: "credit-before-reversal" });
  await observe(incoming);
  assert.equal((await fixture.repository.getOrderById(matchedOrder.id))?.status, "notification_confirmed");
  await observe(
    eventFor(matchedInput, {
      eventId: "reversal-for-matched-credit",
      eventKind: "reversal",
      bankRef: incoming.bankRef,
    }),
  );
  assert.equal((await fixture.repository.getOrderById(matchedOrder.id))?.status, "needs_review");
  const matches = await fixture.pglite.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM credit_matches WHERE order_id = $1",
    [matchedOrder.id],
  );
  assert.equal(matches.rows[0].count, 1, "reversal opens review without deleting the original match");
});

test("expiry is persisted and a fresh observed credit inside the payable window can confirm", async () => {
  const input = orderInput({
    idempotencyScope: "merchant:expiry-window",
    idempotencyKey: "expiry-window",
    expiresAt: new Date(Date.now() + 75_000),
  });
  const order = await fixture.repository.createOrder(input);
  const created = await fixture.repository.getOrderById(order.id);
  assert.ok(created);
  const payAt = new Date(created.createdAt.getTime() + 10_000);
  await fixture.repository.expireOrderIfDue(order.id, new Date(created.expiresAt.getTime() + 1_000));
  assert.equal((await fixture.repository.getOrderById(order.id))?.status, "expired");
  const event = eventFor(input, {
    eventId: "paid-before-expiry-after-link-expired",
    observedAt: payAt.toISOString(),
  });
  await observe(event, "phonepe", new Date(payAt.getTime() + 1_000));
  assert.equal((await fixture.repository.getOrderById(order.id))?.status, "notification_confirmed");
});

test("observer grants and revocation apply at mutation time", async () => {
  const mobileInput = orderInput({
    idempotencyScope: "ignored",
    idempotencyKey: "mobile-link-retry",
    createdByDeviceId: fixture.deviceId,
  });
  const firstLink = await fixture.repository.createDevicePaymentLink({
    order: mobileInput,
    deviceId: fixture.deviceId,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const mobileRetry = await fixture.repository.createDevicePaymentLink({
    order: { ...mobileInput, expiresAt: new Date(0), publicToken: "not-a-new-token", merchantRef: "not-new" },
    deviceId: fixture.deviceId,
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  assert.equal(mobileRetry.id, firstLink.id);
  assert.equal(mobileRetry.publicToken, firstLink.publicToken);

  const code = "observer-only-pairing-0123456789";
  const codeHash = createHash("sha256").update(code).digest("hex");
  await fixture.repository.createPairingCredential({
    codeHash,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    grantedScopes: ["observations"],
    createdBy: "test-operator",
  });
  const observerId = randomUUID();
  await fixture.repository.pairDevice({
    pairingCodeHash: codeHash,
    deviceId: observerId,
    deviceName: "Observer-only phone",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "test-x-coordinate-2", y: "test-y-coordinate-2" },
    nonce: randomBytes(16).toString("base64url"),
    nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
    pairedAt: new Date(),
  });
  await expectRepoCode(
    () =>
      fixture.repository.pairDevice({
        pairingCodeHash: codeHash,
        deviceId: randomUUID(),
        deviceName: "Duplicate code attempt",
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "another-x-coordinate", y: "another-y-coordinate" },
        nonce: randomBytes(16).toString("base64url"),
        nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
        pairedAt: new Date(),
      }),
    "invalid_pairing_code",
  );
  const linkInput = orderInput({
    createdByDeviceId: observerId,
    idempotencyScope: "ignored",
    idempotencyKey: "forbidden-link",
  });
  await expectRepoCode(
    () =>
      fixture.repository.createDevicePaymentLink({
        order: linkInput,
        deviceId: observerId,
        nonce: randomBytes(16).toString("base64url"),
        nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
      }),
    "device_scope_denied",
  );
  await fixture.repository.revokeDevice(observerId, "test-operator");
  await expectRepoCode(
    () =>
      fixture.repository.ingestObservation({
        deviceId: observerId,
        nonce: randomBytes(16).toString("base64url"),
        nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
        receivedAt: new Date(),
        event: eventFor(linkInput, { receiverProfileId: fixture.phonepeProfileId }),
      }),
    "device_revoked",
  );
});

test("bank reconciliation is separate from notification confirmation", async () => {
  const input = orderInput({ idempotencyScope: "merchant:reconcile", idempotencyKey: "reconcile" });
  const order = await fixture.repository.createOrder(input);
  const event = eventFor(input, { eventId: "reconcile-event" });
  await observe(event);
  const confirmed = await fixture.repository.getOrderById(order.id);
  assert.equal(confirmed?.status, "notification_confirmed");
  assert.equal(confirmed?.bankReconciliationStatus, "unreconciled");
  await fixture.repository.reconcileOrder({
    orderId: order.id,
    actorId: "test-operator",
    officialBankReference: event.bankRef as string,
    reason: "Verified the credit in the receiving bank statement",
  });
  const reconciled = await fixture.repository.getOrderById(order.id);
  assert.equal(reconciled?.status, "notification_confirmed");
  assert.equal(reconciled?.bankReconciliationStatus, "reconciled");
  assert.equal(reconciled?.reconciledBy, "test-operator");
});

test("manual review links a reference-free credit to only the operator-selected order", async () => {
  const firstInput = orderInput({
    idempotencyScope: "merchant:manual-review-a",
    idempotencyKey: "manual-review-a",
  });
  const secondInput = orderInput({
    idempotencyScope: "merchant:manual-review-b",
    idempotencyKey: "manual-review-b",
  });
  const firstOrder = await fixture.repository.createOrder(firstInput);
  const secondOrder = await fixture.repository.createOrder(secondInput);
  const officialReference = `UTR${randomBytes(8).toString("hex").toUpperCase()}`;

  await observe(
    eventFor(firstInput, {
      eventId: "manual-review-reference-free-credit",
      merchantRef: null,
      bankRef: officialReference,
    }),
  );

  assert.equal((await fixture.repository.getOrderById(firstOrder.id))?.status, "pending");
  assert.equal((await fixture.repository.getOrderById(secondOrder.id))?.status, "pending");
  const queue = await fixture.repository.listReviewQueue(20);
  const item = queue.find((entry) => entry.maskedBankRef === `••••${officialReference.slice(-4)}`);
  assert.ok(item, "reference-free credit is available in the operator review queue");

  await fixture.repository.reviewCredit({
    creditId: item.creditId,
    orderId: firstOrder.id,
    actorId: "test-operator",
    reason: "Matched the bank statement credit to the customer order",
    evidenceReference: "Bank statement line 14, verified by operator",
    officialBankReference: officialReference,
  });

  const confirmed = await fixture.repository.getOrderById(firstOrder.id);
  const untouched = await fixture.repository.getOrderById(secondOrder.id);
  assert.equal(confirmed?.status, "notification_confirmed");
  assert.equal(confirmed?.bankReconciliationStatus, "reconciled");
  assert.equal(confirmed?.reconciledBy, "test-operator");
  assert.equal(confirmed?.officialBankReference, officialReference);
  assert.equal(untouched?.status, "pending", "same amount does not link a second order");

  const matchCount = await fixture.pglite.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM credit_matches cm
     JOIN bank_credits bc ON bc.id = cm.bank_credit_id
     WHERE bc.receiver_account_id = $1 AND bc.bank_ref = $2`,
    [fixture.receiverAccountId, officialReference],
  );
  assert.equal(matchCount.rows[0].count, 1, "one underlying credit links to exactly one order");
  const reconciliationCount = await fixture.pglite.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM bank_reconciliations WHERE order_id = $1",
    [firstOrder.id],
  );
  assert.equal(reconciliationCount.rows[0].count, 1);
  const audit = await fixture.pglite.query<{ actions: string[] }>(
    `SELECT array_agg(action ORDER BY action) AS actions FROM audit_events
     WHERE target_id IN ($1, $2)`,
    [item.creditId, firstOrder.id],
  );
  assert.ok(audit.rows[0].actions.includes("credit_manually_confirmed"));
  assert.ok(audit.rows[0].actions.includes("bank_reconciled"));
  assert.equal(
    (await fixture.repository.listReviewQueue(20)).some((entry) => entry.creditId === item.creditId),
    false,
  );
});

test("database rate limits persist counts and reset after their window", async () => {
  const keyHash = createHmac("sha256", "synthetic-rate-limit-secret").update(randomUUID()).digest("hex");
  const windowStart = new Date(Date.now() - 10_000);

  assert.equal(await fixture.repository.allowRateLimit(keyHash, 1, 60, windowStart), true);
  assert.equal(await fixture.repository.allowRateLimit(keyHash, 1, 60, windowStart), false);
  assert.equal(
    await fixture.repository.allowRateLimit(keyHash, 1, 60, new Date(windowStart.getTime() + 60_001)),
    true,
  );
});

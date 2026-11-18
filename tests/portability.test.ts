import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";
import type { DeviceScope, NewOrderInput } from "@/lib/domain/types";
import { buildUpiPaymentUri, pairingResponse, paymentLinkResponse } from "@/lib/observer/checkout";
import type { QueryExecutor, TransactionalDatabase } from "@/lib/server/db/client";
import { runMigrations } from "@/lib/server/db/migrations";
import { createGatewayRepository, GatewayRepositoryError } from "@/lib/server/db/repository";

const APPLE_ORIGIN = "https://alpha-gateway.invalid";
const BIRCH_ORIGIN = "https://birch-gateway.invalid";

function executor(client: PGliteInterface | Transaction): QueryExecutor {
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

async function newInstallation(secret: string) {
  const pglite = new PGlite();
  const database: TransactionalDatabase = {
    ...executor(pglite),
    transaction<Result>(work: (client: QueryExecutor) => Promise<Result>) {
      return pglite.transaction((tx) => work(executor(tx)));
    },
  };
  await runMigrations(database);
  return { pglite, repository: createGatewayRepository(database, secret) };
}

function orderInput(settings: {
  merchantName: string;
  payeeVpa: string;
  key: string;
  scope: string;
}): NewOrderInput {
  return {
    amountPaise: 49_950,
    description: "Portability fixture",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    merchantDisplayName: settings.merchantName,
    payeeVpa: settings.payeeVpa,
    idempotencyScope: settings.scope,
    idempotencyKey: settings.key,
    requestFingerprint: createHash("sha256").update(`${settings.scope}:${settings.key}`).digest("hex"),
    createdByDeviceId: null,
    merchantRef: `WZ${randomBytes(12).toString("hex").toUpperCase()}`,
    publicToken: randomBytes(32).toString("base64url"),
  };
}

test("two isolated gateway installations keep checkout and pairing data instance-scoped", async (t) => {
  const alpha = await newInstallation("alpha-order-token-secret-32-characters");
  const birch = await newInstallation("birch-order-token-secret-32-characters");

  try {
    const alphaSettings = {
      merchantName: "Alpha Bicycle Shop",
      payeeVpa: "alpha-shop@upi",
      origin: APPLE_ORIGIN,
    };
    const birchSettings = {
      merchantName: "Birch Book Shop",
      payeeVpa: "birch-books@upi",
      origin: BIRCH_ORIGIN,
    };

    await alpha.repository.createReceiverAccount({
      label: "Alpha receiving account",
      payeeVpa: alphaSettings.payeeVpa,
      verifiedBy: "alpha-test-operator",
      verified: true,
    });
    await birch.repository.createReceiverAccount({
      label: "Birch receiving account",
      payeeVpa: birchSettings.payeeVpa,
      verifiedBy: "birch-test-operator",
      verified: true,
    });

    const alphaOrder = await alpha.repository.createOrder(
      orderInput({
        merchantName: alphaSettings.merchantName,
        payeeVpa: alphaSettings.payeeVpa,
        key: "alpha-portability-order",
        scope: "merchant:alpha",
      }),
    );
    const birchOrder = await birch.repository.createOrder(
      orderInput({
        merchantName: birchSettings.merchantName,
        payeeVpa: birchSettings.payeeVpa,
        key: "birch-portability-order",
        scope: "merchant:birch",
      }),
    );

    const alphaUri = new URL(buildUpiPaymentUri(alphaOrder));
    const birchUri = new URL(buildUpiPaymentUri(birchOrder));
    assert.equal(alphaUri.protocol, "upi:");
    assert.equal(alphaUri.hostname, "pay");
    assert.equal(alphaUri.searchParams.get("pa"), alphaSettings.payeeVpa);
    assert.equal(alphaUri.searchParams.get("pn"), alphaSettings.merchantName);
    assert.equal(alphaUri.searchParams.get("am"), "499.50");
    assert.equal(alphaUri.searchParams.get("cu"), "INR");
    assert.equal(alphaUri.searchParams.get("tr"), alphaOrder.merchantRef);

    assert.equal(birchUri.protocol, "upi:");
    assert.equal(birchUri.hostname, "pay");
    assert.equal(birchUri.searchParams.get("pa"), birchSettings.payeeVpa);
    assert.equal(birchUri.searchParams.get("pn"), birchSettings.merchantName);
    assert.equal(birchUri.searchParams.get("am"), "499.50");
    assert.equal(birchUri.searchParams.get("cu"), "INR");
    assert.equal(birchUri.searchParams.get("tr"), birchOrder.merchantRef);
    assert.notEqual(alphaUri.searchParams.get("pa"), birchUri.searchParams.get("pa"));
    assert.notEqual(alphaUri.searchParams.get("pn"), birchUri.searchParams.get("pn"));

    const alphaLink = paymentLinkResponse(alphaOrder, alphaSettings.origin);
    const birchLink = paymentLinkResponse(birchOrder, birchSettings.origin);
    assert.equal(new URL(alphaLink.checkoutUrl).origin, alphaSettings.origin);
    assert.equal(new URL(alphaLink.checkoutUrl).pathname, `/checkout/${alphaOrder.publicToken}`);
    assert.equal(new URL(birchLink.checkoutUrl).origin, birchSettings.origin);
    assert.equal(new URL(birchLink.checkoutUrl).pathname, `/checkout/${birchOrder.publicToken}`);
    assert.notEqual(alphaLink.checkoutUrl, birchLink.checkoutUrl);

    const pairingCode = "alpha-instance-only-pairing-code";
    const pairingCodeHash = createHash("sha256").update(pairingCode).digest("hex");
    await alpha.repository.createPairingCredential({
      codeHash: pairingCodeHash,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      grantedScopes: ["observations"],
      createdBy: "alpha-test-operator",
    });
    const deviceId = randomUUID();
    const pairedDevice = await alpha.repository.pairDevice({
      pairingCodeHash,
      deviceId,
      deviceName: "Alpha observer",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "synthetic-alpha-x", y: "synthetic-alpha-y" },
      nonce: randomBytes(16).toString("base64url"),
      nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
      pairedAt: new Date(),
    });
    assert.equal(pairedDevice.id, deviceId);
    assert.deepEqual(pairedDevice.grantedScopes, ["observations"] satisfies DeviceScope[]);

    const alphaPairingResponse = pairingResponse({
      gatewayOrigin: alphaSettings.origin,
      merchantDisplayName: alphaSettings.merchantName,
      payeeVpa: alphaSettings.payeeVpa,
      device: pairedDevice,
    });
    const birchPairingResponse = pairingResponse({
      gatewayOrigin: birchSettings.origin,
      merchantDisplayName: birchSettings.merchantName,
      payeeVpa: birchSettings.payeeVpa,
      device: { id: randomUUID(), grantedScopes: ["observations"] },
    });
    assert.deepEqual(alphaPairingResponse, {
      gatewayOrigin: alphaSettings.origin,
      merchantDisplayName: alphaSettings.merchantName,
      payeeVpa: alphaSettings.payeeVpa,
      currency: "INR",
      apiVersion: "1.0.0",
      deviceId,
      grantedScopes: ["observations"],
    });
    assert.equal(birchPairingResponse.gatewayOrigin, birchSettings.origin);
    assert.equal(birchPairingResponse.payeeVpa, birchSettings.payeeVpa);
    assert.notEqual(alphaPairingResponse.gatewayOrigin, birchPairingResponse.gatewayOrigin);

    const deviceInBirch = await birch.repository.getDevice(deviceId);
    assert.equal(deviceInBirch, null);
    await assert.rejects(
      () =>
        birch.repository.acceptSignedDeviceRequest({
          deviceId,
          nonce: randomBytes(16).toString("base64url"),
          nonceExpiresAt: new Date(Date.now() + 10 * 60_000),
          requiredScope: "observations",
        }),
      (error: unknown) => error instanceof GatewayRepositoryError && error.code === "unknown_device",
    );

    await t.test("each installation resolves its own public checkout token", async () => {
      assert.equal(
        (await alpha.repository.getOrderByToken(alphaOrder.publicToken))?.payeeVpaSnapshot,
        alphaSettings.payeeVpa,
      );
      assert.equal(
        (await birch.repository.getOrderByToken(birchOrder.publicToken))?.payeeVpaSnapshot,
        birchSettings.payeeVpa,
      );
      assert.equal(await birch.repository.getOrderByToken(alphaOrder.publicToken), null);
      assert.equal(await alpha.repository.getOrderByToken(birchOrder.publicToken), null);
    });
  } finally {
    await Promise.all([alpha.pglite.close(), birch.pglite.close()]);
  }
});

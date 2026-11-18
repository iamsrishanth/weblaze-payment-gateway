import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigurationError,
  getPublicGatewayConfig,
  loadBootstrapConfig,
  loadGatewayConfig,
} from "../src/lib/config-core";

type TestEnvironment = Record<string, string | undefined>;

function secret(character: string) {
  return character.repeat(48);
}

function settings(overrides: TestEnvironment = {}): TestEnvironment {
  return {
    NODE_ENV: "test",
    MERCHANT_DISPLAY_NAME: "Copper Finch Studio",
    GATEWAY_PUBLIC_ORIGIN: "https://copper-finch.example.test",
    UPI_PAYEE_VPA: "copper.finch@synthetic",
    DATABASE_URL: "postgresql://test:test@localhost:5432/gateway_test",
    MERCHANT_API_KEY: secret("a"),
    SESSION_SECRET: secret("b"),
    ORDER_TOKEN_SECRET: secret("c"),
    ...overrides,
  };
}

test("loads one installation's validated synthetic settings and exposes only public fields", () => {
  const first = loadGatewayConfig(settings());
  const second = loadGatewayConfig(
    settings({
      MERCHANT_DISPLAY_NAME: "Mango Circuit",
      GATEWAY_PUBLIC_ORIGIN: "https://mango-circuit.example.test",
      UPI_PAYEE_VPA: "mango.circuit@synthetic",
      MERCHANT_API_KEY: secret("d"),
      SESSION_SECRET: secret("e"),
      ORDER_TOKEN_SECRET: secret("f"),
    }),
  );

  assert.deepEqual(getPublicGatewayConfig(first), {
    gatewayOrigin: "https://copper-finch.example.test",
    merchantDisplayName: "Copper Finch Studio",
    payeeVpa: "copper.finch@synthetic",
    currency: "INR",
  });
  assert.equal(getPublicGatewayConfig(second).gatewayOrigin, "https://mango-circuit.example.test");
  assert.equal(JSON.stringify(getPublicGatewayConfig(first)).includes(first.merchantApiKey), false);
});

test("rejects production placeholders before the gateway can accept payments", () => {
  assert.throws(
    () => loadGatewayConfig(settings({ NODE_ENV: "production" })),
    (error) => error instanceof ConfigurationError && /public DNS hostname/.test(error.message),
  );
  assert.throws(
    () =>
      loadGatewayConfig(
        settings({
          NODE_ENV: "production",
          GATEWAY_PUBLIC_ORIGIN: "https://checkout.copperfinch.in",
          MERCHANT_DISPLAY_NAME: "Example Workshop",
        }),
      ),
    /real configured merchant label/,
  );
  assert.throws(
    () =>
      loadGatewayConfig(
        settings({
          NODE_ENV: "production",
          GATEWAY_PUBLIC_ORIGIN: "https://checkout.copperfinch.in",
          MERCHANT_DISPLAY_NAME: "Copper Finch Studio",
          UPI_PAYEE_VPA: "merchant@example.test",
        }),
      ),
    /real receiving UPI ID/,
  );
  assert.throws(
    () =>
      loadGatewayConfig(
        settings({
          NODE_ENV: "production",
          GATEWAY_PUBLIC_ORIGIN: "https://gateway.invalid",
          MERCHANT_DISPLAY_NAME: "Copper Finch Studio",
          UPI_PAYEE_VPA: "copper.finch@finchpay",
          DATABASE_URL: "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@pg.copper-finch.studio/gateway",
        }),
      ),
    /real public DNS hostname/,
  );
  assert.throws(
    () =>
      loadGatewayConfig(
        settings({
          NODE_ENV: "production",
          GATEWAY_PUBLIC_ORIGIN: "https://checkout.copper-finch.studio",
          MERCHANT_DISPLAY_NAME: "Copper Finch Studio",
          UPI_PAYEE_VPA: "copper.finch@finchpay",
          DATABASE_URL:
            "postgresql://gateway_user:replace-with-database-secret@pg.copper-finch.studio/gateway",
        }),
      ),
    /non-placeholder production database credentials/,
  );
  assert.throws(
    () =>
      loadGatewayConfig(
        settings({
          NODE_ENV: "production",
          GATEWAY_PUBLIC_ORIGIN: "https://checkout.copper-finch.studio",
          MERCHANT_DISPLAY_NAME: "Copper Finch Studio",
          UPI_PAYEE_VPA: "copper.finch@finchpay",
          DATABASE_URL: "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@pg.copper-finch.invalid/gateway",
        }),
      ),
    /real PostgreSQL host/,
  );
});

test("accepts a complete synthetic production configuration and explicit Compose database host", () => {
  const validProduction = settings({
    NODE_ENV: "production",
    MERCHANT_DISPLAY_NAME: "Copper Finch Studio",
    GATEWAY_PUBLIC_ORIGIN: "https://checkout.copper-finch.studio",
    UPI_PAYEE_VPA: "copper.finch@finchpay",
    DATABASE_URL: "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@pg.copper-finch.studio/gateway",
    MERCHANT_API_KEY: "F1r7A2b9C4d6E8g0H2j5K7m9N1p3Q6s8",
    SESSION_SECRET: "Q8w2E5r7T1y4U6i9O3p5A7s0D2f4G6h8",
    ORDER_TOKEN_SECRET: "M3n6B8v1C4x7Z9a2S5d0F3g6H8j1K4p7",
  });
  assert.equal(loadGatewayConfig(validProduction).nodeEnv, "production");

  assert.throws(
    () =>
      loadGatewayConfig({
        ...validProduction,
        DATABASE_URL: "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@db:5432/gateway",
      }),
    /reachable DNS hostname/,
  );
  assert.equal(
    loadGatewayConfig({
      ...validProduction,
      DATABASE_URL: "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@db:5432/gateway",
      ALLOW_PRIVATE_DATABASE_HOST: "true",
    }).databaseUrl,
    "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@db:5432/gateway",
  );
});

test("production rejects IP-literal and loopback origins and requires a DNS database host by default", () => {
  const production = settings({
    NODE_ENV: "production",
    MERCHANT_DISPLAY_NAME: "Copper Finch Studio",
    GATEWAY_PUBLIC_ORIGIN: "https://checkout.copper-finch.studio",
    UPI_PAYEE_VPA: "copper.finch@finchpay",
    DATABASE_URL: "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@pg.copper-finch.studio/gateway",
    MERCHANT_API_KEY: "F1r7A2b9C4d6E8g0H2j5K7m9N1p3Q6s8",
    SESSION_SECRET: "Q8w2E5r7T1y4U6i9O3p5A7s0D2f4G6h8",
    ORDER_TOKEN_SECRET: "M3n6B8v1C4x7Z9a2S5d0F3g6H8j1K4p7",
  });

  for (const origin of [
    "https://127.0.0.1",
    "https://2130706433",
    "https://[::1]",
    "https://[2001:db8::1]",
    "https://localhost.",
    "https://gateway.localhost",
  ]) {
    assert.throws(
      () => loadGatewayConfig({ ...production, GATEWAY_PUBLIC_ORIGIN: origin }),
      ConfigurationError,
      origin,
    );
  }

  for (const databaseUrl of [
    "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@localhost.:5432/gateway",
    "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@127.0.0.1:5432/gateway",
    "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@[::1]:5432/gateway",
    "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@[2001:db8::1]:5432/gateway",
  ]) {
    assert.throws(
      () => loadGatewayConfig({ ...production, DATABASE_URL: databaseUrl }),
      /reachable DNS hostname/,
    );
  }

  assert.equal(
    loadGatewayConfig({
      ...production,
      DATABASE_URL: "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@db:5432/gateway",
      ALLOW_PRIVATE_DATABASE_HOST: "true",
    }).databaseUrl,
    "postgresql://gateway_user:R4v8-Gw2d-Kf7s-Xc5q-N1p3@db:5432/gateway",
  );
});

test("rejects non-canonical origins, invalid VPA values, and short secrets", () => {
  assert.throws(
    () => loadGatewayConfig(settings({ GATEWAY_PUBLIC_ORIGIN: "https://shop.example.test/checkout" })),
    /canonical origin/,
  );
  assert.throws(
    () => loadGatewayConfig(settings({ GATEWAY_PUBLIC_ORIGIN: "https://shop.example.test/" })),
    /canonical origin/,
  );
  assert.throws(() => loadGatewayConfig(settings({ UPI_PAYEE_VPA: "not a vpa" })), /valid UPI address/);
  assert.throws(() => loadGatewayConfig(settings({ SESSION_SECRET: "short" })), /at least 32 characters/);
});

test("requires an explicit one-time administrator identity and strong password", () => {
  assert.deepEqual(
    loadBootstrapConfig({
      BOOTSTRAP_ADMIN_EMAIL: "owner@copper-finch.studio",
      BOOTSTRAP_ADMIN_PASSWORD: "correct horse battery stapler 2026",
    }),
    {
      email: "owner@copper-finch.studio",
      password: "correct horse battery stapler 2026",
    },
  );
  assert.throws(
    () =>
      loadBootstrapConfig({
        BOOTSTRAP_ADMIN_EMAIL: "owner@copper-finch.studio",
        BOOTSTRAP_ADMIN_PASSWORD: "replace-with-a-unique-password",
      }),
    /unique password/,
  );
  assert.throws(
    () =>
      loadBootstrapConfig({
        BOOTSTRAP_ADMIN_EMAIL: "operator@example.test",
        BOOTSTRAP_ADMIN_PASSWORD: "a-long-enough-synthetic-password",
      }),
    /real operator identity/,
  );
});

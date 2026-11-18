# Weblaze Payment Gateway

Weblaze Payment Gateway is an original, self-hostable UPI checkout and merchant terminal for one merchant and one operator per installation. It creates fixed INR payment links to the one receiving UPI ID configured by the operator. Customers pay with their existing UPI app; customers do not install the Weblaze Android companion.

The checkout displays a locally generated QR and a “Pay with any UPI app” link built from the same server-created `upi://pay` URI. It polls a minimal public status view. A browser action, screenshot, return from a UPI app, or customer-entered value cannot mark an order as paid. PhonePe observations and eligible bank SMS notifications from the merchant’s paired Android phone can provisionally confirm an exact, eligible credit. Notifications are not a payment-provider or bank settlement guarantee. Reconcile against the receiving bank before fulfillment unless your separate fulfillment policy has another trusted verification source.

The payer’s UPI app may show the account holder’s bank-registered name instead of the configured merchant display name. Confirm that the receiving UPI ID is eligible for the kind of merchant payments you intend to accept.

## Contract and companion app

The gateway contract is versioned independently of any merchant or hostname. The tested protocol release is `contract-v1.0.1`. The Android build can vendor or pin that exact revision without sharing a workspace.

- [Observer API contract](contracts/observer-v1.md)
- [OpenAPI description](contracts/openapi.yaml)
- [Android companion source](https://github.com/iamsrishanth/weblaze-android)

Pair each new installation again using its own canonical HTTPS URL and a short-lived code shown after the operator signs in. The companion app creates a P-256 device key locally and proves possession during pairing. The operator grants observation and payment-link scopes separately; existing observer-only devices do not gain link access unless the operator enables it. Revoking a device blocks its next request.

## Requirements

- Node.js 22 or newer and npm, or Docker Engine with the Docker Compose plugin
- PostgreSQL 16 or newer. Use a persistent database and a network-compatible PostgreSQL connection URL on serverless hosts.
- A public HTTPS hostname for production
- A receiving UPI ID that is authorized and able to accept your intended merchant payments

## Configure a fresh installation

All configuration is server-side. Do not place a payee ID, API key, administrator password, database credential, or session secret in frontend code, a public repository, an Android build, or a public issue. Use a private local environment file or your hosting provider’s private environment settings. Never reuse production secrets in previews or another installation.

1. Clone the standalone repository and enter its root:

   ```sh
   git clone https://github.com/iamsrishanth/weblaze-payment-gateway.git
   cd weblaze-payment-gateway
   ```

2. Copy the safe template to an ignored local file and replace every example value:

   ```sh
   cp .env.example .env.local
   ```

   On PowerShell, use `Copy-Item .env.example .env.local`. `.env.local` is ignored by Git. For local development only, set `NODE_ENV=development` and `GATEWAY_PUBLIC_ORIGIN=http://localhost:3000`. Production requires a canonical HTTPS origin with no path, query, or trailing slash. Production startup rejects missing settings, malformed origins or UPI IDs, and obvious placeholder values before accepting requests.

3. Set these required application values in `.env.local` or in the host’s private settings:

   | Variable                   | Purpose                                                                                                                                     |
   | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
   | `NODE_ENV`                 | `development`, `test`, or `production`.                                                                                                     |
   | `MERCHANT_DISPLAY_NAME`    | Customer-facing merchant label; it is also passed as the UPI intent’s `pn` value.                                                           |
   | `GATEWAY_PUBLIC_ORIGIN`    | The single canonical origin used to build checkout links and pair devices. Use HTTPS in production.                                         |
   | `UPI_PAYEE_VPA`            | The sole receiving UPI ID. It is the UPI intent’s `pa` value and cannot be supplied by a customer or API caller.                            |
   | `DATABASE_URL`             | PostgreSQL connection URL. In Compose mode, use host `db`; for Vercel use the provider’s pooled/serverless-compatible connection string.    |
   | `MERCHANT_API_KEY`         | Secret bearer credential for server-to-server order creation and status lookup.                                                             |
   | `SESSION_SECRET`           | Secret used to protect operator sessions.                                                                                                   |
   | `ORDER_TOKEN_SECRET`       | Secret used to protect public checkout tokens.                                                                                              |
   | `BOOTSTRAP_ADMIN_EMAIL`    | Initial operator email, used only by the one-time bootstrap command.                                                                        |
   | `BOOTSTRAP_ADMIN_PASSWORD` | Unique initial password of at least 16 characters, used only by bootstrap. Remove both bootstrap values after the administrator is created. |

   Docker Compose also reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` to initialize its local database container. `POSTGRES_PASSWORD` must be unique and private. Compose uses `GATEWAY_PORT` only as an optional loopback host port; it defaults to `3000`.

   Generate each application secret independently with Node.js and store the output directly in your private environment settings:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   Run it separately for `MERCHANT_API_KEY`, `SESSION_SECRET`, and `ORDER_TOKEN_SECRET`. Use a different random password for `POSTGRES_PASSWORD` and a different unique password for `BOOTSTRAP_ADMIN_PASSWORD`. Do not use the template’s sample values in production.

4. Choose a database setup below, apply migrations, and create the first administrator. The bootstrap command is intentionally one-time: it fails if an administrator already exists. After it succeeds, remove `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` from the private settings and sign in with the created account.

### Docker Compose self-host

Compose provides a persistent named PostgreSQL volume (`weblaze-postgres`) and a production-mode gateway container. The Compose file sets `ALLOW_PRIVATE_DATABASE_HOST=true` only for the gateway container so its `DATABASE_URL` can use the internal `db` service name. Do not set that private-database override in Vercel or another public deployment. Keep PostgreSQL private to the Compose network. Put a TLS reverse proxy in front of the gateway and point your public hostname at that proxy; do not expose the application container directly to the public internet.

1. In `.env.local`, set `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` to private values. Set `DATABASE_URL` to the same credentials and database name with `db` as its hostname, for example:

   ```text
   DATABASE_URL=postgresql://weblaze_gateway:YOUR_PRIVATE_PASSWORD@db:5432/weblaze_gateway
   ```

   Replace `YOUR_PRIVATE_PASSWORD` and keep the value URL-encoded if it contains reserved URL characters. Set the merchant name, receiving UPI ID, canonical HTTPS origin, application secrets, and bootstrap values described above.

2. Start PostgreSQL and wait for its health check:

   ```sh
   docker compose --env-file .env.local up -d db
   ```

3. Build the operator tools image and apply database migrations:

   ```sh
   docker compose --env-file .env.local build migrate
   docker compose --env-file .env.local run --rm migrate
   ```

4. Create the first administrator, then remove the bootstrap email and password from `.env.local`:

   ```sh
   docker compose --env-file .env.local run --rm bootstrap
   ```

5. Build and start the gateway. The Compose dependency also verifies that migrations completed successfully:

   ```sh
   docker compose --env-file .env.local up --build -d gateway
   ```

   The gateway listens on `127.0.0.1:3000` by default. Configure your TLS reverse proxy to forward the selected hostname to that local port, preserve the original `Host` header, and set `X-Forwarded-Proto: https`. The gateway uses the first `X-Forwarded-For` value for rate limits, so configure the proxy to overwrite that header with the client address it observed; never append an untrusted caller-supplied value. Set `GATEWAY_PUBLIC_ORIGIN` to the exact HTTPS origin users and the Android companion will enter. Restart after changing environment settings. A named volume preserves PostgreSQL data across container restarts; back it up and test restoration as part of operations.

6. Open the HTTPS origin, sign in, generate a pairing code from the device screen, and grant the scopes the device needs. On Android, enter that same HTTPS origin and code.

7. Before creating a link, open **Receiving account context** in the terminal. Add the receiving account only after checking the bank record, and confirm that its payee UPI ID exactly matches the configured `UPI_PAYEE_VPA`. Use a non-sensitive display label because paired merchant devices can see it. The optional account hint accepts exactly the last four digits; never enter a full account number. Signed receiver-profile discovery returns that suffix to the paired device and sanitizes the display label. For each paired device that will send payment observations, add a profile tied to that verified account and device. Select **PhonePe** for PhonePe observations and/or **Bank SMS** for approved bank-credit notifications. For a Bank SMS profile, enter a non-sensitive `sourceTemplateId` key of 1–64 characters: it must start with a letter, use only letters, digits, period, underscore, colon, or hyphen, and contain at most three digits total. Do not put a VPA, email address, phone number, account number, or other personal identifier in this key. The format check reduces accidental disclosure but cannot identify every encoded or letter-based identifier. The signed event's template identity must exactly match the registered profile; a sender label alone is insufficient. Missing or mismatched sender/template identity, receiver profile, or recipient context stays in manual review and will not automatically confirm an order.

8. Create a fixed-amount test link in the merchant terminal. Open it in a separate customer browser and confirm that it shows the configured merchant label, description, INR amount, payee ID, order reference, expiry, QR, and live status. If you make a real test payment, use an amount you selected and reconcile the credit in the receiving bank. Automated acceptance tests use synthetic credits and do not move funds.

To stop the services without deleting data, run `docker compose --env-file .env.local down`. Do not use `down -v` unless you intend to delete the database volume.

### Run locally with Node.js

Set `DATABASE_URL` to a running local PostgreSQL database, then install, migrate, bootstrap, build, and start:

```sh
npm ci
npm run db:migrate
npm run admin:bootstrap
npm run build
npm start
```

Run `npm run dev` for local development. Use a local-only receiving UPI ID and synthetic orders when exercising checkout locally; the browser can still open a real UPI app if the link points to a real recipient.

## Deploy on Vercel

Vercel is the recommended first host for the Weblaze owner deployment. Each production and preview environment needs its own private secrets and PostgreSQL database. Check that the selected Vercel plan permits the intended commercial use and review its current resource limits before production. [Vercel plan guidance](https://vercel.com/docs/limits/fair-use-guidelines). This repository does not create or purchase hosting or database services.

### Use Supabase PostgreSQL

The gateway connects to PostgreSQL from server-side code with `DATABASE_URL`; it does not use Supabase Auth or a browser-exposed Supabase key. In Supabase, open **Connect**, select **Direct connection string**, then choose **Transaction pooler** for short-lived Vercel Function connections. Copy the URI Supabase provides, including its required SSL settings, and store it as the private `DATABASE_URL` value in Vercel. Do not use an anon or service-role API key as a database password, and never add the URI to a `NEXT_PUBLIC_` variable or Android build. Keep a separate direct URL only if your migration workflow requires it.

The migration enables row-level security on gateway tables and adds no policies for Supabase’s Data API roles. Only the server-side PostgreSQL connection should have access. Before accepting live payments, confirm the chosen Supabase plan provides suitable backups and retention for payment evidence; test restoring a backup.

1. Select a PostgreSQL database and hosting plan that permit the intended use. For Supabase, use the Transaction pooler URI for Vercel Functions and keep all credentials private.
2. Import `iamsrishanth/weblaze-payment-gateway` into Vercel from the repository root. `vercel.json` selects Next.js, `npm ci`, and `npm run build`.
3. In Vercel’s private project settings, configure the required application variables above for both Preview and Production. Use a synthetic origin, receiver, database, and secrets for Preview. In Production, set `GATEWAY_PUBLIC_ORIGIN` to the exact HTTPS hostname assigned to this installation. Configure the merchant name and receiving UPI ID only in the private Production environment. Keep bootstrap credentials private and remove them after initialization.
4. Run `npm run db:migrate` against the intended database from a trusted operator environment with `DATABASE_URL` supplied privately. Run `npm run admin:bootstrap` once with the one-time bootstrap variables set, then remove those values. Never commit a pulled production environment file.
5. Build and deploy the production branch. Add only the selected hostname to the intended Vercel project. Vercel will show the DNS record it expects; add that exact record at the authoritative DNS provider and preserve unrelated records. Do not guess a universal target or replace a live record without reviewing it. Wait for domain verification and TLS provisioning. [Vercel custom-domain setup](https://vercel.com/docs/domains/set-up-custom-domain).
6. Verify the homepage, operator sign-in, checkout, pairing, and API on the final HTTPS origin. Sign in, create a pairing code, and enter the HTTPS origin and code in the Android companion. Before creating a link, add and verify the receiving account against the configured payee, then add a PhonePe and/or approved Bank SMS profile for the paired device as described in the Docker Compose walkthrough. For Bank SMS, use the exact approved, non-sensitive `sourceTemplateId` key (1–64 chars, starts with a letter, allowed letters/digits/period/underscore/colon/hyphen, at most three digits total) for the bank sender and validated incoming-credit template used by the companion; do not use personal identifiers. The event identity must match the profile. Missing or mismatched sender/template or receiver context remains in manual review. Then create a test payment link and open it in a separate customer browser.

For updates, review and deploy a tested commit, apply backward-compatible database migrations before the new app needs them, then verify the public flow. Keep separate database backups and a rollback plan before schema changes.

## Payment API quick example

Store `MERCHANT_API_KEY` only in a server-side secret store. Never expose it in browser JavaScript or Android resources. Amounts use positive integer paise, not floating-point rupees. A repeated idempotency key with the same request returns the original order; reusing it with a different request returns a conflict. A deliberately created second link needs a new key.

Generate and persist one idempotency key and request body per intended business action. Retry with those same values after a timeout or lost response. If you set an explicit expiry, preserve that exact timestamp for retries. Generate a new key and payload for a deliberately new link.

```js
const gatewayOrigin = process.env.GATEWAY_PUBLIC_ORIGIN;
const merchantApiKey = process.env.MERCHANT_API_KEY;

const createResponse = await fetch(`${gatewayOrigin}/api/v1/orders`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${merchantApiKey}`,
    "content-type": "application/json",
    "idempotency-key": "website.deposit.2026.0001",
  },
  body: JSON.stringify({
    amountPaise: 49950,
    description: "Website deposit",
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  }),
});
if (!createResponse.ok) throw new Error(`Order creation failed: ${createResponse.status}`);
const order = await createResponse.json();
console.log(order.checkoutUrl);

const statusResponse = await fetch(`${gatewayOrigin}/api/v1/orders/${order.orderId}`, {
  headers: { authorization: `Bearer ${merchantApiKey}` },
  cache: "no-store",
});
if (!statusResponse.ok) throw new Error(`Status lookup failed: ${statusResponse.status}`);
const currentOrder = await statusResponse.json();
```

The API fixes the receiver and currency from server configuration. The public checkout URL contains only an opaque token. Opening, sharing, or returning from that URL never confirms payment. See the OpenAPI contract for request bounds, error responses, Android signatures, idempotency behavior, and synthetic interoperability fixtures.

## Payment evidence and review

Orders use `pending`, `notification_confirmed`, `needs_review`, or `expired` states. A notification-confirmed status means eligible merchant-phone evidence was observed; it does not mean the bank has reconciled the credit. Bank reconciliation is tracked separately with the operator, time, official reference, reason, and evidence reference.

Only an incoming credit with an eligible active device and validated source/account context, a matching recipient, the exact INR amount, an exact merchant order reference, a credit time within the order’s payable period, and an unused bank reference can automatically confirm an order. Credits missing a reliable link or bank reference, reversals, late credits, duplicate references, and conflicts stay in review. A reference-free credit does not select an order by amount and time. Use the merchant review queue to inspect the receiving bank record, establish the order link, record why it was confirmed, or leave the credit open.

If a customer says they paid after a link expires, or the terminal has not confirmed a payment yet, ask them not to pay a second time. Keep the order or credit in review, check the receiving bank account, and link the credit to the order only when the bank record supports it. A customer screenshot or payer-supplied UTR alone is not proof of payment.

## Checks and security

The CI workflow runs linting, type checks, synthetic tests, and a production build. Locally, run:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Use synthetic observations and reserved `.invalid` origins for automated tests. Do not test by generating synthetic-looking alerts on a real merchant phone. Keep logs free of session values, API keys, full bank references, and unnecessary personal data. Apply HTTPS at every public endpoint, keep backups private, rotate leaked secrets immediately, and revoke/re-pair devices when a merchant phone is lost.

Rotating `SESSION_SECRET` ends existing operator sessions. Rotating `ORDER_TOKEN_SECRET` invalidates outstanding public checkout tokens; expire those orders and issue replacement links before changing the value, or use a key migration that preserves existing tokens. Rotating `MERCHANT_API_KEY` also requires updating every server-side integration that calls the gateway.

MIT-licensed original code is provided in this repository. `THIRD_PARTY_NOTICES.md` carries the production dependency license notices into source and Docker redistributions; keep it with the image and application source.

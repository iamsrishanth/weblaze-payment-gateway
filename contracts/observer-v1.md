# Weblaze Observer Contract v1

This document and `openapi.yaml` define the interoperable Android-to-gateway API. The wire protocol contains no merchant or hostname constants. Each installation returns its own canonical origin, display name, and receiving VPA during pairing. The tested backward-compatible contract patch is `contract-v1.0.1`; `contract-v1.0.0` remains the original immutable baseline. The API's negotiated `apiVersion` remains `1.0.0`. Independent installations use the same contract and pair afresh.

## Version negotiation

Every device request, including pairing, MUST send `X-Weblaze-Contract-Version: 1`. The v1 routes are under `/api/v1/`. A missing, malformed, or unsupported version returns HTTP `409` with `{"error":{"code":"unsupported_version","message":"This gateway does not support the requested contract version.","supportedVersions":[1]}}`. A pair response identifies the selected API as `apiVersion: "1.0.0"`. A client that cannot negotiate v1 MUST stop rather than silently downgrade.

## Pairing and grants

An authenticated terminal operator creates a random, single-use pairing code that expires after 10 minutes. The terminal shows the canonical HTTPS origin returned from validated server configuration, the code, and selected grants. The operator types that origin and code into the merchant's Android app. Customers do not install this companion app. Pairing does not accept a URL, destination VPA, name, or scope from an unauthenticated client as authority: the entered HTTPS host must be the configured `GATEWAY_PUBLIC_ORIGIN`, and the request proves possession of a newly generated P-256 private key.

The client creates a P-256 key pair on-device and sends only the public key as a JWK (`kty=EC`, `crv=P-256`, 32-byte base64url `x` and `y`, no padding). It signs the exact request bytes below with ECDSA/SHA-256. The private key never leaves the device. A successful pair consumes the code and returns:

```json
{
  "gatewayOrigin": "https://gateway.operator.example",
  "merchantDisplayName": "Example Workshop",
  "payeeVpa": "example.workshop@upi",
  "currency": "INR",
  "apiVersion": "1.0.0",
  "deviceId": "4d16a8e2-89c4-4fd2-897b-732d4d456e7d",
  "grantedScopes": ["observations"]
}
```

The example values are synthetic. The response origin, name, and VPA always come from that instance's validated server configuration. The code can be used once, expires after ten minutes, and is stored only as a hash. Rate limits apply to login and pairing. A failed or expired code must be replaced in the signed-in terminal. Re-pairing to another instance requires a fresh code and key registration there.

The default grant is `observations`. `links:create` and `links:read_own` are separate grants. An operator may grant them during pairing or later. A device paired before link grants existed remains observer-only until the operator explicitly enables each grant. Revocation and grant changes apply to the next authenticated request. The signed-in terminal can revoke and re-pair a device.

## Signed request envelope

All signed requests use HTTPS and JSON (except an empty `GET` body). The server rejects bodies larger than 32 KiB, timestamps outside ±5 minutes, invalid signatures, unknown devices, revoked devices, missing scopes, and reused nonces. The request nonce is 16 random bytes or more encoded as unpadded base64url; the 16-byte minimum is 22 characters. The timestamp is Unix epoch milliseconds as decimal digits. Header names are case-insensitive; header values are not trimmed before validation except surrounding HTTP optional whitespace removed by the HTTP stack.

Required headers:

| Header                       | Value                                                                 |
| ---------------------------- | --------------------------------------------------------------------- |
| `X-Weblaze-Contract-Version` | `1`                                                                   |
| `X-Weblaze-Timestamp`        | Unix epoch milliseconds, e.g. `1767225600000`                         |
| `X-Weblaze-Nonce`            | Fresh unpadded base64url random value, at least 16 decoded bytes      |
| `X-Weblaze-Signature`        | Unpadded base64url of ASN.1 DER ECDSA P-256 signature                 |
| `X-Weblaze-Device-Id`        | Required after pairing; omitted only from `POST /api/v1/devices/pair` |
| `Idempotency-Key`            | Required for link creation; omitted elsewhere                         |

The client hashes the exact UTF-8 HTTP body bytes with SHA-256 and lower-case hexadecimal. A `GET` signs the SHA-256 digest of the empty body (`e3b0c442...b855`). It signs the raw path and query in their sent order, including percent-encoding, and no scheme, host, or fragment. It MUST NOT parse and reserialize JSON before calculating the hash. The canonical UTF-8 bytes are these seven LF-separated fields, with no trailing LF:

```text
WEBLAZE-OBSERVER/1
<UPPERCASE HTTP METHOD>
<raw path and query, or path alone>
<timestamp in decimal milliseconds>
<nonce>
<Idempotency-Key, or the literal hyphen - when absent>
<lowercase SHA-256 hex of exact body bytes>
```

The signature is `ECDSA(P-256, SHA-256(canonical bytes))`, DER-encoded and base64url without `=`. The public JWK is imported with its supplied `x` and `y`; `d` MUST NOT appear in the request. Pairing uses the public key in the body for this proof-of-possession signature. Other routes look up the registered key using `X-Weblaze-Device-Id`.

## Rate limits

After a valid signature and scope check, each device receives up to 120 observation uploads per minute, 30 payment-link creations per minute, 120 own-link list requests per minute, and 120 receiver-profile discovery requests per minute. These buckets are keyed by an HMAC of the installation secret and device ID, so client-supplied IP headers cannot move a signed device between buckets. A limit response is HTTP `429` with `Retry-After` and `retryAfterSeconds`; the attempt is not accepted. A retry must wait, then use a fresh nonce and the same event ID or idempotency key. Public checkout status is limited to 120 requests per minute per request source, and pairing attempts are limited to 10 per 10 minutes per request source.

The server records a valid nonce durably with the operation. A repeated nonce fails with HTTP `409 replay_detected`, even if the body is identical. If a response was lost, the client MUST send the same event or idempotent link with a fresh nonce; exact event or idempotency replay is safe. A body changed after signing fails signature validation. A repeated event ID with different normalized content returns HTTP `409 event_id_conflict`.

## Receiver-profile discovery (contract patch v1.0.1)

`GET /api/v1/receiver-profiles` is an optional backward-compatible discovery endpoint. It requires the `observations` grant and the same signed request envelope as other device endpoints, with an empty body, a fresh nonce, and the configured HTTPS origin. Any non-null request body is rejected before authentication; bodies above 32 KiB receive HTTP `413`, and smaller bodies receive HTTP `400`. The server checks device status and scope on each request. It returns `Cache-Control: no-store, private` and only profiles assigned to that device that are active, have a verified receiving account, and match the current instance's configured payee VPA. A changed or stale receiver account is not exposed.

The response keeps `apiVersion: "1.0.0"`. Each `displayName` is the operator-entered, non-sensitive verified account label. The device response normalizes and collapses whitespace, then allows only short Unicode letters, marks, spaces, and ordinary punctuation; other values become `Verified receiving account`. A `bank_sms` profile has its exact nonempty operator-approved `sourceTemplateId`; `phonepe` profiles have `sourceTemplateId: null`. A receiver-profile `sourceTemplateId` uses a restricted key format: 1–64 characters, starts with an ASCII letter, contains only ASCII letters, digits, period, underscore, colon, and hyphen, and has at most three digits total. New admin profile creation rejects invalid keys, and discovery omits unsafe legacy profiles. Existing v1 observations still match their configured receiver profile by exact stored key, including legacy keys that discovery omits. Operators must still choose a non-sensitive key; a character filter cannot identify every encoded or letter-based personal identifier. `maskedAccountSuffix` is either null or exactly four ASCII digits. Operators may enter only the last four digits when creating a receiver account; the gateway rejects and never stores a full account number. Full receiver VPAs, account numbers, device IDs, and private verification records are never included.

```json
{
  "apiVersion": "1.0.0",
  "gatewayOrigin": "https://gateway.operator.example",
  "receiverProfiles": [
    {
      "id": "c14cd31a-0299-46a4-b94a-90ead0506b77",
      "source": "phonepe",
      "displayName": "Example Workshop current account",
      "maskedAccountSuffix": "4827",
      "sourceTemplateId": null
    },
    {
      "id": "73577f00-f681-4c2d-ae5c-aadd406f9922",
      "source": "bank_sms",
      "displayName": "Example Workshop current account",
      "maskedAccountSuffix": "4827",
      "sourceTemplateId": "fixture-bank-credit-v1"
    }
  ]
}
```

The endpoint was added without changing the contract-version header or existing request schemas. Gateways on `contract-v1.0.0` may return HTTP `404` because they do not implement this optional route. Clients must handle that status as “receiver-profile discovery unavailable,” ignore the response body, and retain their existing observer behavior; they must not treat it as a pairing/authentication failure or try another origin.

## Canonical observation event

`POST /api/v1/observations` accepts one event at a time. All v1 properties below are required; optional observations use explicit `null` rather than omitting fields. Amount is a positive integer number of INR paise. `observedAt` is a UTC RFC 3339 timestamp ending in `Z`. This contract distinguishes the Weblaze/device `eventId`, the exact gateway-generated `merchantRef`, the receiving bank's UTR/RRN `bankRef`, and an app or bank feed's `sourceTransactionId`. A PhonePe internal transaction ID is not a merchant reference or bank UTR.

```json
{
  "schemaVersion": 1,
  "eventId": "evt_fixture_0001",
  "source": "phonepe",
  "eventKind": "incoming_credit",
  "observedAt": "2026-01-01T00:00:00.000Z",
  "amountPaise": 24900,
  "currency": "INR",
  "merchantRef": "WZ000000000000000000000001",
  "bankRef": "TESTUTR000000000001",
  "observedPayeeVpa": "fixture.merchant@upi",
  "receiverProfileId": null,
  "sourceTransactionId": "phonepe-internal-test-001",
  "sourceTemplateId": null
}
```

`source` is `phonepe` or `bank_sms`; `eventKind` is `incoming_credit` or `reversal`. `receiverProfileId` identifies an operator-enrolled profile tied to an active device, approved source, and merchant-verified receiving-account context. For SMS, the gateway requires an active `bank_sms` profile and validated bank-credit template in addition to the notification sender label. A profile cannot be claimed by the device in an observation; it must have been enrolled by the operator. Missing or unapproved context remains open for review.

An `incoming_credit` is eligible for automatic provisional confirmation only if the device and source are active/approved, recipient/account context is verified and maps to this gateway's configured receiver, INR amount matches exactly, `merchantRef` is an exact live order reference, the observation's `observedAt` is within that order's payable interval, and a nonempty `bankRef` has not been used for another credit in the same verified receiving-account identity. The database enforces that bank-reference uniqueness across source-specific profiles that share the same verified account identity. Amount/time similarity alone and buyer-supplied bank references are never matching criteria. Missing bank reference, conflicting or late content, unverified account/source context, and unmatched credits enter merchant review without changing an arbitrary order. A reversal is always sent to review and never erases the audit trail.

Each uploaded event has a unique `(deviceId,eventId)` identity. Durable underlying credits use a separate verified-account-scoped bank-reference identity. PhonePe and bank-SMS reports with the same verified account and bank reference are attached as corroborating evidence to that one credit. Transactional uniqueness and row locking prevent retries or concurrent requests from crediting a second order. Events with no bank reference remain review evidence and cannot auto-confirm an order.

An accepted request returns HTTP `202` only after the event, nonce, matching/review outcome, and evidence are committed. A same-device retry using a fresh nonce and the same event ID/content returns HTTP `200` with `duplicate: true` after verifying the durable prior commit. A different payload under a consumed event ID conflicts. Reversal and unmatched-event acknowledgments are still durable; they do not imply payment success.

## Merchant-created payment links from Android

`POST /api/v1/payment-links` requires `links:create` and `Idempotency-Key`. Its signed body is `{ "amountPaise": 49950, "description": "Website deposit", "expiresAt": "2026-01-01T01:00:00.000Z" }`. `description` is optional plain text, 1–120 printable characters when supplied. `expiresAt` is optional UTC RFC 3339 and must be between 1 minute and 24 hours from creation. Omission defaults to 15 minutes. Amount must be an integer from 1 through 10,000,000 paise (₹0.01 through ₹1,00,000.00). The payee and currency are never accepted from the phone.

The idempotency key is 1–128 ASCII characters matching `[A-Za-z0-9._~]`. It is part of the signature canonical bytes, after the nonce line. The key is scoped to the device, method, path, and normalized request payload. Concurrent duplicates and retries after a lost response return the original order and URL, including when a retry arrives after the order's expiry. The same key with a different payload returns HTTP `409 idempotency_conflict`; a deliberately created second link must use a new key. The gateway generates a unique reference, opaque customer token, and canonical checkout URL on the configured HTTPS origin.

Successful response:

```json
{
  "orderId": "9fd5fd5d-06ce-446b-b18e-4fc6c8b87755",
  "merchantRef": "WZ000000000000000000000001",
  "amountPaise": 49950,
  "description": "Website deposit",
  "expiresAt": "2026-01-01T01:00:00.000Z",
  "status": "pending",
  "checkoutUrl": "https://gateway.operator.example/checkout/OPAQUE_TOKEN"
}
```

The values above are synthetic. `GET /api/v1/payment-links` requires `links:read_own` and returns up to the 100 most recent orders created by that device, with current status and checkout URL. It does not return evidence, customer identifiers, or another device's links. Opening or sharing a link does not alter its payment state.

## Errors and retries

Errors use `{"error":{"code":"...","message":"..."}}`. `400 invalid_request` covers malformed fields; `400 https_required` means a pairing or signed-device request did not use HTTPS, except for an explicitly allowed local-development origin; `401 unauthorized` covers missing or invalid auth; `403 insufficient_scope` covers grants; `404 not_found` hides foreign order identifiers; `409` covers conflicts, replay, or unsupported versions; `410 pairing_expired` covers used/expired pairing; `413 body_too_large` covers bodies above 32 KiB; `421 origin_mismatch` means the HTTP `Host` or `X-Forwarded-Host` header differs from the configured gateway hostname; `429 rate_limited` includes a bounded `Retry-After` HTTP header in seconds and the same value as JSON `retryAfterSeconds`; and `500 internal_error` contains no secrets or personal data. Clients may retry transient `5xx` responses with a fresh timestamp/nonce and the same event ID or idempotency key. A client MUST NOT infer a payment from a UPI app callback, screenshot, button click, or lack of an API error.

## Synthetic interoperability material

`fixtures/v1` contains a public synthetic P-256 key and signed known-good vector. Its test private key is intentionally public and MUST never be reused. The altered-body fixture keeps the signature but changes one byte in `amountPaise`; verification MUST fail. The altered-key fixture replaces the public key and MUST fail. The payment-link acceptance fixture drives link creation, a lost-response retry, customer checkout, and a matching synthetic credit end to end.

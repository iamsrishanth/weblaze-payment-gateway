"use client";

import { type FormEvent, type ReactNode, useState } from "react";

type Scope = "observations" | "links:create" | "links:read_own";
type PaymentStatus = "pending" | "notification_confirmed" | "needs_review" | "expired";

interface TerminalOrder {
  orderId: string;
  merchantRef: string;
  amountPaise: number;
  amountLabel: string;
  description: string | null;
  expiresAt: string;
  createdAt: string;
  checkoutUrl: string;
  status: PaymentStatus;
  statusLabel: string;
  createdByDeviceId: string | null;
  paymentSource: "phonepe" | "bank_sms" | null;
  reconciliationStatus: "unreconciled" | "reconciled";
  reconciledAt: string | null;
  reconciledBy: string | null;
  maskedOfficialBankReference: string | null;
}

interface TerminalDevice {
  id: string;
  name: string;
  grantedScopes: Scope[];
  revokedAt: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

interface PairingCredential {
  id: string;
  grantedScopes: Scope[];
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

interface ReviewItem {
  creditId: string;
  candidateOrderId: string | null;
  candidateMerchantRef: string | null;
  amountPaise: number;
  amountLabel: string;
  observedAt: string;
  source: "phonepe" | "bank_sms";
  maskedBankRef: string | null;
  maskedMerchantRef: string | null;
  reason: string;
}

interface ReceiverAccount {
  id: string;
  label: string;
  payeeVpa: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
}

interface ReceiverProfile {
  id: string;
  receiverAccountId: string;
  deviceId: string;
  source: "phonepe" | "bank_sms";
  sourceTemplateId: string | null;
  active: boolean;
  createdAt: string;
}

interface TerminalData {
  gatewayOrigin: string;
  merchantDisplayName: string;
  payeeVpa: string;
  currency: "INR";
  scopeOptions: Scope[];
  orders: TerminalOrder[];
  devices: TerminalDevice[];
  pairingCredentials: PairingCredential[];
  reviewQueue: ReviewItem[];
  receiverAccounts: ReceiverAccount[];
  receiverProfiles: ReceiverProfile[];
}

interface NewLink {
  orderId: string;
  merchantRef: string;
  amountPaise: number;
  description: string | null;
  expiresAt: string;
  status: PaymentStatus;
  checkoutUrl: string;
}

interface PairingResult {
  code: string;
  gatewayOrigin: string;
  expiresAt: string;
  grantedScopes: Scope[];
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(value));
}

function statusTone(status: PaymentStatus) {
  if (status === "notification_confirmed") return "good";
  if (status === "needs_review") return "review";
  if (status === "expired") return "bad";
  return "";
}

function rupeesToPaise(value: string) {
  const match = value.trim().match(/^(\d{1,8})(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("Enter an amount with up to two decimal places.");
  const amount = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10_000_000)
    throw new Error("Amount must be between ₹0.01 and ₹1,00,000.00.");
  return amount;
}

function randomIdempotencyKey() {
  return crypto.randomUUID().replaceAll("-", "");
}

async function sendJson<T>(url: string, method: string, data?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (data !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(url, {
    method,
    headers,
    cache: "no-store",
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message ?? "The request could not be completed.");
  return payload as T;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Each call site supplies a form control as children.
    <label className="terminal-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ScopeChoices({
  initial,
  namePrefix,
  onChange,
  allowRemove = true,
}: {
  initial: Scope[];
  namePrefix: string;
  onChange: (value: Scope[]) => void;
  allowRemove?: boolean;
}) {
  const [selected, setSelected] = useState<Scope[]>(initial);
  const toggle = (scope: Scope) => {
    if (!allowRemove && initial.includes(scope) && selected.includes(scope)) return;
    const next = selected.includes(scope) ? selected.filter((item) => item !== scope) : [...selected, scope];
    setSelected(next);
    onChange(next);
  };
  return (
    <fieldset className="terminal-checks">
      <legend>Device grants</legend>
      <label className="terminal-check">
        <input
          type="checkbox"
          name={`${namePrefix}-observations`}
          checked={selected.includes("observations")}
          onChange={() => toggle("observations")}
        />{" "}
        Payment observations
      </label>
      <label className="terminal-check">
        <input
          type="checkbox"
          name={`${namePrefix}-links-create`}
          checked={selected.includes("links:create")}
          onChange={() => toggle("links:create")}
        />{" "}
        Create payment links
      </label>
      <label className="terminal-check">
        <input
          type="checkbox"
          name={`${namePrefix}-links-read_own`}
          checked={selected.includes("links:read_own")}
          onChange={() => toggle("links:read_own")}
        />{" "}
        View own links
      </label>
    </fieldset>
  );
}

export default function AdminTerminal({
  initialData,
  adminEmail,
}: {
  initialData: TerminalData;
  adminEmail: string;
}) {
  const [data, setData] = useState(initialData);
  const [flash, setFlash] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newLink, setNewLink] = useState<NewLink | null>(null);
  const [pairing, setPairing] = useState<PairingResult | null>(null);
  const [pairScopes, setPairScopes] = useState<Scope[]>(["observations"]);
  const [grantDrafts, setGrantDrafts] = useState<Record<string, Scope[]>>({});

  async function refresh() {
    const response = await fetch("/api/admin/data", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message ?? "Could not refresh the terminal.");
    setData(payload as TerminalData);
  }

  async function action(key: string, message: string, work: () => Promise<void>) {
    setBusy(key);
    setFlash(null);
    try {
      await work();
      await refresh();
      setFlash({ text: message, error: false });
    } catch (error) {
      setFlash({
        text: error instanceof Error ? error.message : "The request could not be completed.",
        error: true,
      });
    } finally {
      setBusy(null);
    }
  }

  async function createLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const amountPaise = rupeesToPaise(String(form.get("amount") ?? ""));
      const description = String(form.get("description") ?? "").trim();
      const expiryInput = String(form.get("expiresAt") ?? "");
      const expiresAt = expiryInput ? new Date(expiryInput).toISOString() : undefined;
      const body = { amountPaise, description: description || null, ...(expiresAt ? { expiresAt } : {}) };
      await action("create-link", "Payment link created.", async () => {
        const result = await sendJson<NewLink>("/api/admin/orders", "POST", body, randomIdempotencyKey());
        setNewLink(result);
        formElement.reset();
      });
    } catch (error) {
      setFlash({ text: error instanceof Error ? error.message : "Enter a valid link amount.", error: true });
    }
  }

  async function createPairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action(
      "pairing",
      "Pairing code created. It can be used once for the next ten minutes.",
      async () => {
        const grantedScopes: Scope[] = pairScopes.length ? pairScopes : ["observations"];
        const result = await sendJson<PairingResult>("/api/admin/pairing-codes", "POST", { grantedScopes });
        setPairing(result);
        setPairScopes(grantedScopes);
      },
    );
  }

  async function updateGrants(device: TerminalDevice) {
    const grantedScopes = grantDrafts[device.id] ?? device.grantedScopes;
    if (!grantedScopes.length) {
      setFlash({ text: "Keep at least one grant, or revoke this device instead.", error: true });
      return;
    }
    await action(`grants-${device.id}`, "Device grants updated.", async () => {
      await sendJson(`/api/admin/devices/${device.id}/grants`, "PATCH", { grantedScopes });
    });
  }

  async function revokeDevice(device: TerminalDevice) {
    await action(`revoke-${device.id}`, "Device revoked. Its next request will be denied.", async () => {
      await sendJson(`/api/admin/devices/${device.id}/revoke`, "POST");
    });
  }

  async function confirmReview(event: FormEvent<HTMLFormElement>, item: ReviewItem) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      orderId: String(form.get("orderId") ?? ""),
      officialBankReference: String(form.get("officialBankReference") ?? "").trim(),
      evidenceReference: String(form.get("evidenceReference") ?? "").trim(),
      reason: String(form.get("reason") ?? "").trim(),
    };
    await action(`review-${item.creditId}`, "Credit linked after bank review.", async () => {
      await sendJson(`/api/admin/reviews/${item.creditId}/confirm`, "POST", body);
    });
  }

  async function reconcile(event: FormEvent<HTMLFormElement>, order: TerminalOrder) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      orderId: order.orderId,
      officialBankReference: String(form.get("officialBankReference") ?? "").trim(),
      reason: String(form.get("reason") ?? "").trim(),
    };
    await action(`reconcile-${order.orderId}`, "Bank reconciliation recorded.", async () => {
      await sendJson(`/api/admin/orders/${order.orderId}/reconcile`, "POST", body);
    });
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const confirmed = form.get("confirmBankRecord") === "on";
    if (!confirmed) {
      setFlash({ text: "Confirm that you checked the receiving account in the bank record.", error: true });
      return;
    }
    await action("receiver-account", "Verified receiving account context added.", async () => {
      await sendJson("/api/admin/receiver-accounts", "POST", {
        label: String(form.get("label") ?? "").trim(),
        payeeVpa: data.payeeVpa,
        verified: true,
        confirmation: "I checked the receiving account in the bank record.",
      });
      formElement.reset();
    });
  }

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const source = String(form.get("source"));
    const sourceTemplateId = String(form.get("sourceTemplateId") ?? "").trim();
    await action("receiver-profile", "Receiver profile added.", async () => {
      await sendJson("/api/admin/receiver-profiles", "POST", {
        receiverAccountId: String(form.get("receiverAccountId") ?? ""),
        deviceId: String(form.get("deviceId") ?? ""),
        source,
        sourceTemplateId: sourceTemplateId || null,
      });
      formElement.reset();
    });
  }

  async function logout() {
    try {
      await sendJson("/api/admin/logout", "POST");
      window.location.assign("/admin");
    } catch (error) {
      setFlash({ text: error instanceof Error ? error.message : "Could not sign out.", error: true });
    }
  }

  const usableOrders = data.orders.filter((order) => order.status !== "notification_confirmed");
  const activeDevices = data.devices.filter((device) => !device.revokedAt);

  return (
    <main className="terminal-shell">
      <header className="terminal-header">
        <div>
          <div className="brand-lockup">
            <span className="brand-mark">W</span>
            <span>Weblaze</span>
          </div>
          <h1 className="terminal-heading" style={{ marginTop: 15 }}>
            Merchant terminal
          </h1>
          <p className="terminal-subtitle">
            Signed in as {adminEmail} · {data.merchantDisplayName} · {data.payeeVpa}
          </p>
        </div>
        <div className="terminal-inline">
          <button
            className="button button-secondary"
            type="button"
            onClick={() => void action("refresh", "Terminal refreshed.", refresh)}
            disabled={Boolean(busy)}
          >
            Refresh
          </button>
          <button className="button button-secondary" type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>

      {flash && (
        <div className={`terminal-flash ${flash.error ? "error" : ""}`} role="status" aria-live="polite">
          {flash.text}
        </div>
      )}

      <section className="terminal-grid">
        <div className="terminal-card">
          <h2>Create a payment link</h2>
          <p className="terminal-subtitle">
            The amount, configured recipient, and INR currency are fixed on the server.
          </p>
          <form onSubmit={createLink}>
            <Field label="Amount in INR">
              <input name="amount" inputMode="decimal" placeholder="499.50" required autoComplete="off" />
            </Field>
            <Field label="Customer description (optional)">
              <input name="description" maxLength={120} placeholder="Website deposit" autoComplete="off" />
            </Field>
            <Field label="Expiry (optional; default 15 minutes)">
              <input name="expiresAt" type="datetime-local" />
            </Field>
            <button className="button button-primary" type="submit" disabled={busy === "create-link"}>
              {busy === "create-link" ? "Creating…" : "Create link"}
            </button>
          </form>
          {newLink && (
            <div className="terminal-flash" style={{ marginTop: 16 }}>
              <strong>
                {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
                  newLink.amountPaise / 100,
                )}{" "}
                · {newLink.merchantRef}
              </strong>
              <div className="terminal-inline" style={{ marginTop: 9 }}>
                <a
                  className="button button-secondary"
                  href={newLink.checkoutUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open checkout
                </a>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void copyText(newLink.checkoutUrl)}
                >
                  Copy link
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="terminal-card">
          <h2>Pair the merchant phone</h2>
          <p className="terminal-subtitle">
            Enter this gateway URL and the one-time code in the Weblaze Android observer app.
          </p>
          <form onSubmit={createPairing}>
            <ScopeChoices initial={pairScopes} namePrefix="pair" onChange={setPairScopes} />
            <button className="button button-primary" type="submit" disabled={busy === "pairing"}>
              {busy === "pairing" ? "Creating…" : "Generate pairing code"}
            </button>
          </form>
          {pairing && (
            <div className="terminal-flash" style={{ marginTop: 16 }}>
              <div className="terminal-list-title">
                Enter on Android before {formatDate(pairing.expiresAt)}
              </div>
              <div className="terminal-list-meta" style={{ margin: "8px 0 5px" }}>
                Gateway URL
              </div>
              <div className="terminal-inline">
                <code className="mono">{pairing.gatewayOrigin}</code>
                <button
                  type="button"
                  className="copy-button"
                  onClick={() => void copyText(pairing.gatewayOrigin)}
                >
                  Copy
                </button>
              </div>
              <div className="terminal-list-meta" style={{ margin: "12px 0 5px" }}>
                Single-use code
              </div>
              <div className="terminal-inline">
                <code style={{ fontSize: 18, fontWeight: 850, letterSpacing: ".12em" }}>{pairing.code}</code>
                <button type="button" className="copy-button" onClick={() => void copyText(pairing.code)}>
                  Copy
                </button>
              </div>
              <div className="terminal-list-meta" style={{ marginTop: 8 }}>
                Grants: {pairing.grantedScopes.join(", ")}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="terminal-card">
        <h2>Payment links</h2>
        {data.orders.length ? (
          <div className="terminal-table-wrap">
            <table className="terminal-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Observed from</th>
                  <th>Bank check</th>
                  <th>Expires</th>
                  <th>Checkout</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((order) => (
                  <tr key={order.orderId}>
                    <td>
                      <span className="mono">{order.merchantRef}</span>
                      {order.description && <div className="terminal-list-meta">{order.description}</div>}
                    </td>
                    <td className="amount">{order.amountLabel}</td>
                    <td>
                      <span className={`terminal-status ${statusTone(order.status)}`}>
                        {order.statusLabel}
                      </span>
                    </td>
                    <td>{order.paymentSource ?? "—"}</td>
                    <td>
                      {order.reconciliationStatus === "reconciled" ? (
                        <>
                          <span className="terminal-status good">Bank reconciled</span>
                          <div className="terminal-list-meta">
                            {formatDate(order.reconciledAt)} · {order.maskedOfficialBankReference}
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="terminal-status">Unreconciled</span>
                          {order.status === "notification_confirmed" && (
                            <form
                              onSubmit={(event) => void reconcile(event, order)}
                              style={{ marginTop: 8, minWidth: 210 }}
                            >
                              <input
                                className="terminal-table-input"
                                style={{ marginBottom: 6 }}
                                name="officialBankReference"
                                placeholder="Official bank reference"
                                required
                                minLength={4}
                                maxLength={128}
                              />
                              <input
                                className="terminal-table-input"
                                style={{ marginBottom: 6 }}
                                name="reason"
                                placeholder="Bank check note"
                                required
                                minLength={10}
                                maxLength={500}
                              />
                              <button
                                className="button button-secondary"
                                type="submit"
                                disabled={busy === `reconcile-${order.orderId}`}
                              >
                                {busy === `reconcile-${order.orderId}` ? "Saving…" : "Record bank check"}
                              </button>
                            </form>
                          )}
                        </>
                      )}
                    </td>
                    <td>{formatDate(order.expiresAt)}</td>
                    <td>
                      <a href={order.checkoutUrl} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="terminal-empty">No payment links yet.</p>
        )}
      </section>

      <section className="terminal-card">
        <h2>Payment review</h2>
        <p className="terminal-subtitle">
          Unmatched or conflicting credits stay open. Link a credit only after checking the receiving bank
          record and establishing the order.
        </p>
        {data.reviewQueue.length ? (
          <div className="terminal-list">
            {data.reviewQueue.map((item) => (
              <article className="terminal-list-item" key={item.creditId}>
                <div style={{ width: "100%" }}>
                  <p className="terminal-list-title">
                    {item.amountLabel} · {item.source} · {formatDate(item.observedAt)}
                  </p>
                  <div className="terminal-list-meta">
                    Candidate: {item.candidateMerchantRef ?? "No order reference"} · bank ref{" "}
                    {item.maskedBankRef ?? "not supplied"} · {item.reason}
                  </div>
                  <form
                    className="terminal-grid"
                    style={{ marginTop: 14 }}
                    onSubmit={(event) => void confirmReview(event, item)}
                  >
                    <div>
                      <Field label="Link to order after bank check">
                        <select name="orderId" required defaultValue={item.candidateOrderId ?? ""}>
                          <option value="" disabled>
                            Select an order
                          </option>
                          {usableOrders.map((order) => (
                            <option value={order.orderId} key={order.orderId}>
                              {order.merchantRef} · {order.amountLabel} · {order.statusLabel}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Official bank reference">
                        <input name="officialBankReference" required minLength={4} maxLength={128} />
                      </Field>
                    </div>
                    <div>
                      <Field label="Evidence reference (internal) ">
                        <input
                          name="evidenceReference"
                          required
                          minLength={2}
                          maxLength={256}
                          placeholder="Bank statement row or terminal note"
                        />
                      </Field>
                      <Field label="Why this credit belongs to the order">
                        <textarea
                          name="reason"
                          required
                          minLength={10}
                          maxLength={500}
                          placeholder="Describe the bank-side check and order link"
                        />
                      </Field>
                    </div>
                    <div className="terminal-inline">
                      <button
                        className="button button-primary"
                        type="submit"
                        disabled={busy === `review-${item.creditId}`}
                      >
                        {busy === `review-${item.creditId}` ? "Saving…" : "Confirm after bank check"}
                      </button>
                    </div>
                  </form>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="terminal-empty">No credits need review.</p>
        )}
      </section>

      <section className="terminal-grid">
        <div className="terminal-card">
          <h2>Devices and grants</h2>
          {data.devices.length ? (
            <div className="terminal-list">
              {data.devices.map((device) => (
                <div className="terminal-list-item" key={device.id}>
                  <div style={{ width: "100%" }}>
                    <p className="terminal-list-title">
                      {device.name} {device.revokedAt && <span className="terminal-status bad">Revoked</span>}
                    </p>
                    <div className="terminal-list-meta mono">{device.id}</div>
                    <div className="terminal-list-meta">
                      Paired {formatDate(device.createdAt)} · last seen {formatDate(device.lastSeenAt)}
                    </div>
                    {!device.revokedAt && (
                      <>
                        <ScopeChoices
                          key={`${device.id}-${device.grantedScopes.join(",")}`}
                          initial={grantDrafts[device.id] ?? device.grantedScopes}
                          namePrefix={device.id}
                          onChange={(next) => setGrantDrafts((drafts) => ({ ...drafts, [device.id]: next }))}
                          allowRemove={false}
                        />
                        <div className="terminal-list-meta">
                          Grants can be enabled here. Revoke the device to remove all access.
                        </div>
                        <div className="terminal-inline">
                          <button
                            className="button button-secondary"
                            type="button"
                            onClick={() => void updateGrants(device)}
                            disabled={Boolean(busy)}
                          >
                            Save grants
                          </button>
                          <button
                            className="button button-danger"
                            type="button"
                            onClick={() => void revokeDevice(device)}
                            disabled={Boolean(busy)}
                          >
                            Revoke device
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="terminal-empty">No paired devices yet.</p>
          )}
        </div>

        <div className="terminal-card">
          <h2>Receiving account context</h2>
          <p className="terminal-subtitle">
            Register a context only after verifying this configured payee against the receiving bank. Profiles
            attach approved app or SMS sources to enrolled devices.
          </p>
          <form onSubmit={createAccount}>
            <Field label="Internal account label">
              <input name="label" required maxLength={80} placeholder="Primary INR receiving account" />
            </Field>
            <div className="terminal-list-meta" style={{ marginBottom: 12 }}>
              Configured payee: <strong>{data.payeeVpa}</strong>
            </div>
            <label className="terminal-check" style={{ alignItems: "flex-start", marginBottom: 14 }}>
              <input type="checkbox" name="confirmBankRecord" /> I checked that this receiving account matches
              the bank record.
            </label>
            <button className="button button-primary" type="submit" disabled={Boolean(busy)}>
              Save verified context
            </button>
          </form>
          <hr className="terminal-divider" />
          <form onSubmit={createProfile}>
            <Field label="Verified receiving account">
              <select name="receiverAccountId" required defaultValue="">
                <option value="" disabled>
                  Select account
                </option>
                {data.receiverAccounts
                  .filter((account) => account.verifiedAt)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label} · {account.payeeVpa}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Enrolled merchant device">
              <select name="deviceId" required defaultValue="">
                <option value="" disabled>
                  Select device
                </option>
                {activeDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Approved observation source">
              <select name="source">
                <option value="phonepe">PhonePe</option>
                <option value="bank_sms">Bank SMS</option>
              </select>
            </Field>
            <Field label="Bank SMS template ID (required for bank_sms)">
              <input name="sourceTemplateId" maxLength={128} placeholder="Exact approved template identity" />
            </Field>
            <button className="button button-secondary" type="submit" disabled={Boolean(busy)}>
              Add receiver profile
            </button>
          </form>
          {(data.receiverAccounts.length > 0 || data.receiverProfiles.length > 0) && (
            <>
              <hr className="terminal-divider" />
              {data.receiverAccounts.map((account) => (
                <div className="terminal-list-item" key={account.id}>
                  <div>
                    <p className="terminal-list-title">{account.label}</p>
                    <div className="terminal-list-meta">
                      {account.payeeVpa} ·{" "}
                      {account.verifiedAt ? `verified ${formatDate(account.verifiedAt)}` : "not verified"}
                    </div>
                  </div>
                </div>
              ))}
              {data.receiverProfiles.map((profile) => (
                <div className="terminal-list-item" key={profile.id}>
                  <div>
                    <p className="terminal-list-title">
                      {profile.source} · {profile.active ? "active" : "inactive"}
                    </p>
                    <div className="terminal-list-meta">
                      Device {profile.deviceId} · account {profile.receiverAccountId}{" "}
                      {profile.sourceTemplateId ? `· template ${profile.sourceTemplateId}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="terminal-card">
        <h2>Recent pairing codes</h2>
        {data.pairingCredentials.length ? (
          <div className="terminal-list">
            {data.pairingCredentials.slice(0, 10).map((credential) => (
              <div className="terminal-list-item" key={credential.id}>
                <div>
                  <p className="terminal-list-title">
                    {credential.usedAt
                      ? "Used"
                      : new Date(credential.expiresAt).getTime() < Date.now()
                        ? "Expired"
                        : "Available"}
                  </p>
                  <div className="terminal-list-meta">
                    Created {formatDate(credential.createdAt)} · expires {formatDate(credential.expiresAt)} ·{" "}
                    {credential.grantedScopes.join(", ")}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="terminal-empty">No pairing codes created.</p>
        )}
      </section>
    </main>
  );
}

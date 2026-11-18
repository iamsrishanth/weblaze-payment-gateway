"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type CheckoutStatus = "pending" | "notification_confirmed" | "needs_review" | "expired";

interface CheckoutOrder {
  orderId: string;
  merchantRef: string;
  amountPaise: number;
  merchantDisplayName: string;
  payeeVpa: string;
  description: string | null;
  status: CheckoutStatus;
  customerStatusLabel: string;
  expiresAt: string;
}

function statusClass(status: CheckoutStatus) {
  if (status === "notification_confirmed") return "status-confirmed";
  if (status === "needs_review") return "status-review";
  if (status === "expired") return "status-expired";
  return "status-pending";
}

function statusMessage(status: CheckoutStatus, expiredLocally: boolean) {
  if (status === "notification_confirmed") {
    return "A payment notification has reached the merchant. Bank reconciliation may still be in progress.";
  }
  if (status === "needs_review") {
    return "The merchant is checking this payment against their bank record. You do not need to send payment details here.";
  }
  if (status === "expired" || expiredLocally) {
    return "If you already paid, wait and refresh this page. Contact the merchant for a bank-side check. Do not pay again.";
  }
  return "After your UPI app shows payment complete, return here. Confirmation can take a little time while the merchant checks the notification.";
}

function formatCountdown(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

function CopyControl({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1700);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="copy-button" onClick={copy} aria-label={`Copy ${label}`}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function CheckoutClient({
  token,
  order: initialOrder,
  paymentUri,
  qrDataUrl,
  amountLabel,
}: {
  token: string;
  order: CheckoutOrder;
  paymentUri: string;
  qrDataUrl: string;
  amountLabel: string;
}) {
  const [status, setStatus] = useState<CheckoutStatus>(initialOrder.status);
  const [serverExpiry, setServerExpiry] = useState(initialOrder.expiresAt);
  const [now, setNow] = useState(() => Date.now());
  const [statusError, setStatusError] = useState("");
  const expiry = useMemo(() => new Date(serverExpiry).getTime(), [serverExpiry]);
  const expiredLocally = status === "pending" && now >= expiry;
  const displayedStatus = expiredLocally ? "expired" : status;
  const timeRemaining = expiry - now;

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/public/checkouts/${token}/status`, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("Could not refresh status.");
      const value = (await response.json()) as { status: CheckoutStatus; expiresAt: string };
      setStatus(value.status);
      setServerExpiry(value.expiresAt);
      setStatusError("");
      return value.status;
    } catch {
      setStatusError("Status is taking longer to refresh. This page will keep trying.");
      return null;
    }
  }, [token]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let delay = 2000;
    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "hidden") {
        const latest = await refreshStatus();
        if (latest && latest !== "pending") return;
        delay = Math.min(delay * 2, 10_000);
      }
      if (!cancelled) timer = window.setTimeout(poll, delay);
    };
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      clearTimer();
      delay = 2000;
      void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    window.addEventListener("pageshow", onReturn);
    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("pageshow", onReturn);
    };
  }, [refreshStatus]);

  const isPayable = status === "pending" && now < expiry;
  const statusLabel =
    displayedStatus === "pending" && !expiredLocally
      ? "Awaiting payment"
      : displayedStatus === "notification_confirmed"
        ? "Payment notification received"
        : displayedStatus === "needs_review"
          ? "Payment being reviewed"
          : "Link expired";

  return (
    <main className="checkout-page">
      <div className="checkout-wrap">
        <header className="checkout-topbar">
          <Link className="brand-lockup" href="/" aria-label="Weblaze home">
            <span className="brand-mark">W</span>
            <span>Weblaze Checkout</span>
          </Link>
          <div className="checkout-secure">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M5.5 8.5V6.25a4.5 4.5 0 0 1 9 0V8.5M4.5 8.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path d="M10 11.3v2.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Direct UPI payment
          </div>
        </header>

        <section className="checkout-card" aria-labelledby="checkout-title">
          <div className="checkout-details">
            <p className="merchant-label">
              Paying <strong>{initialOrder.merchantDisplayName}</strong>
            </p>
            <p className="amount-label">Amount due</p>
            <h1 id="checkout-title" className="checkout-amount">
              {amountLabel}
            </h1>
            {initialOrder.description && <p className="checkout-description">{initialOrder.description}</p>}
            <div
              className={`checkout-status ${statusClass(displayedStatus)}`}
              role="status"
              aria-live="polite"
            >
              {statusLabel}
            </div>
            <dl className="checkout-facts">
              <div className="checkout-fact">
                <dt>Payee UPI ID</dt>
                <dd className="fact-with-copy">
                  <span>{initialOrder.payeeVpa}</span>
                  <CopyControl value={initialOrder.payeeVpa} label="payee UPI ID" />
                </dd>
              </div>
              <div className="checkout-fact">
                <dt>Order reference</dt>
                <dd className="fact-with-copy">
                  <span>{initialOrder.merchantRef}</span>
                  <CopyControl value={initialOrder.merchantRef} label="order reference" />
                </dd>
              </div>
              <div className="checkout-fact">
                <dt>Link expires</dt>
                <dd className="expiry-row">
                  <time dateTime={serverExpiry}>
                    {new Intl.DateTimeFormat("en-IN", {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: "Asia/Kolkata",
                    }).format(new Date(serverExpiry))}
                  </time>
                  <span className={`expiry-countdown ${timeRemaining <= 0 ? "is-expired" : ""}`}>
                    {timeRemaining > 0 ? `· ${formatCountdown(timeRemaining)} left` : "· expired"}
                  </span>
                </dd>
              </div>
            </dl>
            <p className={`checkout-notice ${statusClass(displayedStatus)}`}>
              {statusMessage(displayedStatus, expiredLocally)}
            </p>
          </div>

          <div className="checkout-payment">
            {isPayable ? (
              <>
                <div className="qr-frame">
                  {/* biome-ignore lint/performance/noImgElement: The QR is generated locally as a data URL per order. */}
                  <img
                    src={qrDataUrl}
                    alt={`Scan this UPI QR code to pay ${amountLabel} to ${initialOrder.merchantDisplayName}`}
                    width={320}
                    height={320}
                  />
                </div>
                <p className="qr-heading">Scan with any UPI app</p>
                <p className="qr-note">
                  The QR and payment button use the same fixed amount and payee details.
                </p>
                <div className="checkout-actions">
                  <a className="button button-primary button-full" href={paymentUri}>
                    Pay with any UPI app
                  </a>
                  <CopyControl value={paymentUri} label="UPI payment details" />
                </div>
              </>
            ) : (
              <>
                <p className="qr-heading">Payment request unavailable</p>
                <p className="qr-note">
                  This link is no longer payable. If you already paid, wait and contact the merchant for a
                  bank-side check.
                </p>
              </>
            )}
            <p className="checkout-help">
              Your UPI app or bank may show the account holder’s bank-registered name instead of the merchant
              label above.
            </p>
            <p className="checkout-help">
              After payment, return to this page or use{" "}
              <button type="button" className="copy-button" onClick={() => void refreshStatus()}>
                refresh status
              </button>
              . If you already paid and confirmation is delayed or the link expires, wait and contact the
              merchant for a bank-side check. Do not pay again.
            </p>
            <p className="checkout-error" role="status" aria-live="polite">
              {statusError}
            </p>
          </div>
        </section>
        <p className="checkout-footer">
          Weblaze only shares a direct UPI payment request. Payment status is updated from the merchant’s
          payment notifications and may require a bank-side check.
        </p>
      </div>
    </main>
  );
}

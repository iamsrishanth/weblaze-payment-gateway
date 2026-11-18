import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getRepository } from "@/lib/server/db/repository";
import { buildUpiPaymentUri, customerStatusLabel, formatInr } from "@/lib/server/orders";
import CheckoutClient from "./CheckoutClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CheckoutPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) notFound();
  const repo = await getRepository();
  const order = await repo.getOrderByToken(token);
  if (!order) notFound();
  const current = (await repo.expireOrderIfDue(order.id, new Date())) ?? order;
  const upiUri = buildUpiPaymentUri(current);
  const qrDataUrl = await QRCode.toDataURL(upiUri, {
    errorCorrectionLevel: "Q",
    margin: 2,
    width: 320,
    color: { dark: "#17212b", light: "#ffffff" },
  });
  return (
    <CheckoutClient
      token={token}
      order={{
        orderId: current.id,
        merchantRef: current.merchantRef,
        amountPaise: current.amountPaise,
        merchantDisplayName: current.merchantDisplayNameSnapshot,
        payeeVpa: current.payeeVpaSnapshot,
        description: current.description,
        status: current.status,
        customerStatusLabel: customerStatusLabel(current.status),
        expiresAt: current.expiresAt.toISOString(),
      }}
      paymentUri={upiUri}
      qrDataUrl={qrDataUrl}
      amountLabel={formatInr(current.amountPaise)}
    />
  );
}

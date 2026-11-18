import Link from "next/link";

export default function HomePage() {
  return (
    <main className="landing-shell">
      <section className="landing-panel" aria-labelledby="gateway-title">
        <div className="brand-lockup">
          <span className="brand-mark">W</span>
          <span>Weblaze</span>
        </div>
        <p className="eyebrow">Direct UPI checkout</p>
        <h1 id="gateway-title">A simpler way to collect payments.</h1>
        <p className="landing-copy">
          Create a payment link, share it with your customer, and review payment notifications from your
          merchant phone.
        </p>
        <Link className="button button-primary" href="/admin">
          Open merchant terminal
        </Link>
      </section>
    </main>
  );
}

"use client";

import { type FormEvent, useState } from "react";

export default function LoginForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        setError(result?.error?.message ?? "Sign-in failed. Check your details and try again.");
        setBusy(false);
        return;
      }
      window.location.assign("/admin");
    } catch {
      setError("The terminal could not be reached. Try again.");
      setBusy(false);
    }
  }
  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-lockup">
          <span className="brand-mark">W</span>
          <span>Weblaze</span>
        </div>
        <h1>Merchant terminal</h1>
        <p>Sign in to create payment links, pair the merchant phone, and review payment notifications.</p>
        <form onSubmit={submit}>
          <label className="terminal-field">
            Email
            <input name="email" type="email" autoComplete="username" required maxLength={254} />
          </label>
          <label className="terminal-field">
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={1024}
            />
          </label>
          <p className="login-error" role="alert">
            {error}
          </p>
          <button className="button button-primary button-full" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

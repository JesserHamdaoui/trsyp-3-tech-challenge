"use client";

/**
 * Where an invite email sends the invitee. Supabase's invite link, when
 * clicked, lands here with the session already in the URL (the supabase-js
 * client picks it up automatically on load since detectSessionInUrl
 * defaults to true) -- useSession() below then reflects that session once
 * it's parsed. If the email template instead surfaces a plain OTP code
 * (no link, or the invitee is on a different device than the email), we
 * fall back to a manual email + code form via verifyOtp(). Either path
 * ends the same way: once a session exists, POST /auth/complete-profile
 * to create this user's Profile row (role/full_name/invited_by all came
 * from the invite's metadata, set server-side in /auth/invite).
 */

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import Spinner, { BusyLabel } from "@/components/Spinner";

type Step = "checking" | "needs-code" | "set-password" | "done" | "error";

export default function AcceptInvitePage() {
  const { user, loading: sessionLoading } = useSession();
  const router = useRouter();

  const [step, setStep] = useState<Step>("checking");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (sessionLoading) return;
    setStep((prev) => (user ? "set-password" : prev === "checking" ? "needs-code" : prev));
  }, [sessionLoading, user]);

  // The email button links here with ?token_hash=...&type=...: verify it in the browser, so
  // mail scanners that only fetch the URL can't use up the one-time token. The email is
  // prefilled for the manual code form as a fallback.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const qEmail = q.get("email");
    if (qEmail) setEmail(qEmail);
    const tokenHash = q.get("token_hash");
    const type = q.get("type");
    if (!tokenHash || (type !== "invite" && type !== "recovery")) return;
    let cancelled = false;
    (async () => {
      const { error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (cancelled) return;
      window.history.replaceState(null, "", window.location.pathname); // drop the token from the URL
      if (verifyError && !(await supabase.auth.getSession()).data.session) {
        setError("This link has expired or was already used. Enter the code from the email instead, or ask for a new invite.");
        setStep("needs-code");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleVerifyCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: "invite",
      });
      if (verifyError) throw verifyError;
      // useSession's onAuthStateChange listener picks up the new session
      // and the effect above moves us to "set-password"
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetPassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) throw new Error("No session after setting password.");

      const resp = await fetch(`${process.env.NEXT_PUBLIC_ENGINE_URL}/auth/complete-profile`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        // a profile may already exist if this page was visited twice -- treat that as success
        if (resp.status !== 409) {
          throw new Error(body.detail ?? "Failed to finish account setup.");
        }
      }

      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (step !== "done") return;
    const role = user?.role;
    const t = setTimeout(() => router.replace(role ? `/${role}` : "/"), 1200);
    return () => clearTimeout(t);
  }, [step, user, router]);

  return (
    <main className="page-narrow">
      <div className="rise" style={{ marginBottom: "1.5rem" }}>
        <span className="badge" style={{ background: "var(--sun)", color: "var(--deep-950)" }}>
          YOU&apos;RE INVITED
        </span>
        <h1 style={{ fontSize: "2.4rem", marginTop: "0.6rem" }}>Join the game</h1>
        <p className="muted-on-dark" style={{ marginTop: "0.4rem" }}>
          Finish setting up the account you were invited to.
        </p>
      </div>

      <div className="card" style={{ padding: "2rem" }}>
        {(step === "checking" || sessionLoading) && (
          <p className="pending-note"><Spinner /> Checking your invite link...</p>
        )}

        {step === "needs-code" && (
          <form onSubmit={handleVerifyCode} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <p style={{ fontSize: "0.85rem", color: "var(--foreground-muted)" }}>
              Enter the email you were invited with and the code from your invite email.
            </p>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="code">Invite code</label>
              <input
                id="code"
                type="text"
                required
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            {error && <p className="form-error">{error}</p>}
            <button type="submit" disabled={submitting} className="btn btn-go btn-lg">
              <BusyLabel busy={submitting} busyText="Verifying...">Verify code</BusyLabel>
            </button>
          </form>
        )}

        {step === "set-password" && (
          <form onSubmit={handleSetPassword} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <p style={{ fontSize: "0.85rem", color: "var(--foreground-muted)" }}>
              Signed in as <strong>{user?.email}</strong>. Set a password to finish creating your account.
            </p>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="form-error">{error}</p>}
            <button type="submit" disabled={submitting} className="btn btn-go btn-lg">
              <BusyLabel busy={submitting} busyText="Saving...">Finish setup</BusyLabel>
            </button>
          </form>
        )}

        {step === "done" && (
          <p className="form-success">
            Level 1 unlocked! Taking you to the lobby...
          </p>
        )}
      </div>
    </main>
  );
}

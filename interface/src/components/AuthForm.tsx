"use client";

/**
 * Login-only -- there's no self-signup for any role. Accounts are created
 * by invite (admin invites admins/physiatrists, physiatrist invites
 * patients, see InviteForm + /accept-invite) or, for the single seed
 * admin, directly against Supabase outside the app.
 */

import { useState, FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { Role } from "@/lib/useSession";
import { BusyLabel } from "./Spinner";

export default function AuthForm({ role }: { role: Role }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;

      const actualRole = data.user?.user_metadata?.role;
      if (actualRole !== role) {
        await supabase.auth.signOut();
        throw new Error(`This account isn't registered as a ${role}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ padding: "2rem" }}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
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

        <button type="submit" disabled={loading} className="btn btn-go btn-lg" style={{ marginTop: "0.25rem" }}>
          <BusyLabel busy={loading} busyText="Signing in...">Let&apos;s go!</BusyLabel>
        </button>
      </form>

      <p style={{ fontSize: "0.85rem", color: "var(--foreground-muted)", marginTop: "1.25rem", textAlign: "center" }}>
        New here? You need an invite from {role === "patient" ? "your physiatrist" : "an admin"}.
      </p>
    </div>
  );
}

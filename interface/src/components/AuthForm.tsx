"use client";

import { useState, FormEvent, ReactNode } from "react";
import { supabase } from "@/lib/supabase";

type Role = "admin" | "patient" | "physiatrist";

type LoggedInUser = {
  id: string;
  email: string;
};

export default function AuthForm({
  role,
  children,
}: {
  role: Role;
  children?: ReactNode;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<LoggedInUser | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === "login") {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
        if (data.user) setUser({ id: data.user.id, email: data.user.email ?? "" });
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { role, full_name: fullName },
          },
        });
        if (signUpError) throw signUpError;

        const accessToken = data.session?.access_token;
        if (!accessToken) {
          throw new Error("Sign-up succeeded but no session was returned (check email confirmation settings).");
        }

        const resp = await fetch(`${process.env.NEXT_PUBLIC_ENGINE_URL}/auth/complete-profile`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error(body.detail ?? "Failed to create profile on the backend.");
        }

        if (data.user) setUser({ id: data.user.id, email: data.user.email ?? "" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setUser(null);
    setEmail("");
    setPassword("");
    setFullName("");
  }

  if (user) {
    return (
      <div className="card" style={{ padding: "1.75rem", maxWidth: 400 }}>
        <p style={{ fontSize: "0.85rem", color: "var(--foreground-muted)", marginBottom: "0.2rem" }}>
          Logged in as
        </p>
        <p style={{ fontWeight: 600, fontSize: "1.05rem", marginBottom: "1rem" }}>{user.email}</p>
        {children}
        <button onClick={handleLogout} className="btn btn-outline" style={{ marginTop: "1.25rem", width: "100%" }}>
          Log out
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: "2rem", maxWidth: 400 }}>
      <div
        style={{
          display: "flex",
          background: "var(--surface-muted)",
          borderRadius: "var(--radius-sm)",
          padding: "0.25rem",
          marginBottom: "1.5rem",
        }}
      >
        <button
          onClick={() => setMode("login")}
          className="btn"
          style={{
            flex: 1,
            padding: "0.5rem",
            background: mode === "login" ? "var(--surface)" : "transparent",
            boxShadow: mode === "login" ? "var(--shadow-sm)" : "none",
            color: mode === "login" ? "var(--foreground)" : "var(--foreground-muted)",
          }}
        >
          Log in
        </button>
        <button
          onClick={() => setMode("signup")}
          className="btn"
          style={{
            flex: 1,
            padding: "0.5rem",
            background: mode === "signup" ? "var(--surface)" : "transparent",
            boxShadow: mode === "signup" ? "var(--shadow-sm)" : "none",
            color: mode === "signup" ? "var(--foreground)" : "var(--foreground-muted)",
          }}
        >
          Sign up
        </button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {mode === "signup" && (
          <div className="field">
            <label htmlFor="fullName">Full name</label>
            <input
              id="fullName"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
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

        {error && (
          <p style={{ color: "var(--danger)", fontSize: "0.85rem", margin: 0 }}>{error}</p>
        )}

        <button type="submit" disabled={loading} className="btn btn-primary" style={{ marginTop: "0.25rem" }}>
          {loading ? "Please wait..." : mode === "login" ? "Log in" : "Create account"}
        </button>
      </form>
    </div>
  );
}

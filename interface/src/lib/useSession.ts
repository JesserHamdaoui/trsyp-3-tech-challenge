"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type Role = "admin" | "patient" | "physiatrist";

export interface SessionUser {
  id: string;
  email: string;
  role: Role | null;
}

function toSessionUser(session: Session | null): SessionUser | null {
  if (!session?.user) return null;
  const role = session.user.user_metadata?.role;
  return {
    id: session.user.id,
    email: session.user.email ?? "",
    role: role === "admin" || role === "patient" || role === "physiatrist" ? role : null,
  };
}

/** Restores the Supabase session on mount and keeps it in sync with login/logout
 * events, so auth state survives page reloads instead of resetting to logged-out
 * every time (the previous AuthForm only tracked user in local component state). */
export function useSession() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setUser(toSessionUser(data.session));
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(toSessionUser(session));
      setLoading(false);
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  return { user, loading };
}

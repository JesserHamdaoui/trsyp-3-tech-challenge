"use client";

import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession, Role } from "@/lib/useSession";
import { PageLoader } from "@/components/Spinner";

/** Gates a page behind login, redirecting to that role's login page if the
 * visitor isn't signed in, or isn't signed in as the right role (e.g. a
 * patient hitting a physiatrist-only URL directly). */
export default function AuthGuard({ role, children }: { role: Role; children: ReactNode }) {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user || user.role !== role) {
      router.replace(`/${role}`);
    }
  }, [loading, user, role, router]);

  if (loading) {
    return <PageLoader label="Checking your session..." />;
  }

  if (!user || user.role !== role) {
    return null;
  }

  return <>{children}</>;
}

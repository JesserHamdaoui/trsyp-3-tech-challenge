"use client";

import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/useSession";
import { PageLoader } from "@/components/Spinner";

/** Inverse of AuthGuard: keeps signed-in users off public pages (e.g. the
 * role picker) by sending them to their own role's page. */
export default function GuestGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  const router = useRouter();
  const role = user?.role;

  useEffect(() => {
    if (!loading && role) router.replace(`/${role}`);
  }, [loading, role, router]);

  if (loading || role) {
    return <PageLoader label="Warming up..." />;
  }

  return <>{children}</>;
}

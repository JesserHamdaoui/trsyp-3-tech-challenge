"use client";

import { ReactNode } from "react";
import { useSession, Role } from "@/lib/useSession";
import AppShell from "./AppShell";
import AuthForm from "./AuthForm";
import RoleHeader from "./RoleHeader";
import { PageLoader } from "./Spinner";

/** Role landing route: login form for visitors, the sidebar app for a
 * signed-in user of the matching role. */
export default function RoleGate({
  role,
  title,
  subtitle,
  children,
}: {
  role: Role;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { user, loading } = useSession();

  if (loading) {
    return <PageLoader label="Warming up..." />;
  }

  if (user?.role === role) {
    return (
      <AppShell role={role} title={title} subtitle={subtitle}>
        {children}
      </AppShell>
    );
  }

  return (
    <main className="page-narrow">
      <RoleHeader role={role} />
      <AuthForm role={role} />
    </main>
  );
}

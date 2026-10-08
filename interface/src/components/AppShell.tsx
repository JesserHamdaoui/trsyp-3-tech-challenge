"use client";

import { ReactNode, useCallback, useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession, Role } from "@/lib/useSession";
import { Gamepad2, LineChart, Users, ClipboardList, UserPlus, Dumbbell, Target, HeartPulse, LogOut, Pencil, type LucideIcon } from "lucide-react";
import { Dialog } from "@ark-ui/react/dialog";
import { Portal } from "@ark-ui/react/portal";
import { getMe, updateMyName } from "@/lib/engine";
import Avatar from "./Avatar";
import BrandMark from "./BrandMark";
import { BusyLabel } from "./Spinner";

interface NavItem {
  label: string;
  icon: LucideIcon;
  href?: string;
  /** not built yet -- shown disabled so the roadmap is visible */
  soon?: boolean;
}

const ROLE_META: Record<Role, { label: string; accent: string; accentDeep: string; nav: NavItem[] }> = {
  patient: {
    label: "Patient",
    accent: "var(--accent-patient)",
    accentDeep: "var(--accent-patient-deep)",
    nav: [
      { label: "Games", icon: Gamepad2, href: "/patient" },
      { label: "Progress", icon: LineChart, href: "/patient/progress" },
    ],
  },
  physiatrist: {
    label: "Physiatrist",
    accent: "var(--accent-physiatrist)",
    accentDeep: "var(--accent-physiatrist-deep)",
    nav: [
      { label: "Overview", icon: LineChart, href: "/physiatrist" },
      { label: "My patients", icon: Users, href: "/physiatrist/patients" },
      { label: "Prescriptions", icon: ClipboardList, href: "/physiatrist/prescriptions" },
    ],
  },
  admin: {
    label: "Admin",
    accent: "var(--accent-admin)",
    accentDeep: "var(--accent-admin-deep)",
    nav: [
      { label: "Analytics", icon: LineChart, href: "/admin" },
      { label: "Team", icon: UserPlus, href: "/admin/team" },
      { label: "Patients", icon: HeartPulse, href: "/admin/patients" },
      { label: "Exercises", icon: Dumbbell, href: "/admin/exercises" },
      { label: "Reference attempts", icon: Target, href: "/admin/reference" },
    ],
  },
};

/** Signed-in layout for every role: sidebar nav + content area. */
export default function AppShell({
  role,
  title,
  subtitle,
  children,
}: {
  role: Role;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const { user } = useSession();
  const pathname = usePathname();
  const [fullName, setFullName] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token;
      if (token) getMe(token).then((me) => setFullName(me.full_name)).catch(() => setFullName(""));
    });
  }, [userId]);

  const openEditor = useCallback(() => {
    setDraft(fullName ?? "");
    setNameError(null);
    setEditing(true);
  }, [fullName]);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setNameError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Not logged in.");
      const me = await updateMyName(token, draft.trim());
      setFullName(me.full_name);
      setEditing(false);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Could not save your name.");
    } finally {
      setSaving(false);
    }
  }
  const meta = ROLE_META[role];
  // a sub-route (e.g. /patient/piano) keeps its parent section highlighted
  const activeHref = meta.nav
    .filter((n) => n.href && (pathname === n.href || pathname.startsWith(`${n.href}/`)))
    .sort((a, b) => b.href!.length - a.href!.length)[0]?.href;

  return (
    <div className="shell" style={{ ["--role-accent" as string]: meta.accent, ["--role-accent-deep" as string]: meta.accentDeep }}>
      <aside className="sidebar">
        <Link href={`/${role}`} className="brand" aria-label="Flexa">
          <span className="brand-mark">
            <BrandMark />
          </span>
          Flexa
        </Link>

        <nav className="nav" aria-label="Main">
          <span className="nav-label">{meta.label}</span>
          {meta.nav.map((item) => {
            const Icon = item.icon;
            const inner = (
              <>
                <Icon size={20} strokeWidth={2.4} />
                {item.label}
                {item.soon && <span className="nav-soon">Soon</span>}
              </>
            );
            return item.href && !item.soon ? (
              <Link key={item.label} href={item.href} className="nav-item" aria-current={item.href === activeHref ? "page" : undefined}>
                {inner}
              </Link>
            ) : (
              <span key={item.label} className="nav-item" aria-disabled="true">
                {inner}
              </span>
            );
          })}
        </nav>

        <div className="sidebar-user">
          <button type="button" className="profile-btn" onClick={openEditor} title={user?.email} aria-label="Edit your name">
            <Avatar id={user?.id ?? ""} name={fullName || user?.email} size={44} />
            <span style={{ minWidth: 0, textAlign: "left" }}>
              {fullName === null ? (
                <span className="skeleton skeleton-dark" style={{ display: "block", height: 14, width: 110, marginBottom: 6 }} />
              ) : (
                <span className="profile-name">{fullName || "Add your name"}</span>
              )}
              <span className="profile-role">{meta.label}</span>
            </span>
            <Pencil size={14} strokeWidth={2.8} style={{ marginLeft: "auto", opacity: 0.7 }} />
          </button>
          <button onClick={async () => {
              await supabase.auth.signOut();
              router.replace("/");
            }} className="btn btn-ghost">
            <LogOut size={16} strokeWidth={2.6} /> Log out
          </button>
        </div>
      </aside>

      <div className="shell-main">
        {title && (
          <div className="page-head rise">
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
        )}
        {children}
      </div>

      <Dialog.Root open={editing} onOpenChange={(d) => setEditing(d.open)} lazyMount unmountOnExit>
        <Portal>
          <Dialog.Backdrop className="dialog-backdrop" />
          <Dialog.Positioner className="dialog-positioner">
            <Dialog.Content className="card dialog-content" style={{ width: "min(420px, 100%)", textAlign: "left" }}>
              <div style={{ display: "flex", justifyContent: "center", marginBottom: "0.75rem" }}>
                <Avatar id={user?.id ?? ""} name={draft} size={72} />
              </div>
              <Dialog.Title className="display" style={{ fontSize: "1.5rem", textAlign: "center" }}>
                What should we call you?
              </Dialog.Title>
              <form onSubmit={saveName} style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1.1rem" }}>
                <div className="field">
                  <label htmlFor="display-name">Display name</label>
                  <input id="display-name" required maxLength={80} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
                </div>
                {nameError && <p className="form-error">{nameError}</p>}
                <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
                  <Dialog.CloseTrigger className="btn btn-outline" type="button">Cancel</Dialog.CloseTrigger>
                  <button type="submit" disabled={saving || !draft.trim()} className="btn btn-go">
                    <BusyLabel busy={saving} busyText="Saving...">Save</BusyLabel>
                  </button>
                </div>
              </form>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </div>
  );
}

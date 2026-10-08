"use client";

import { useCallback, useEffect, useState, FormEvent } from "react";
import { Tabs } from "@ark-ui/react/tabs";
import { Dialog } from "@ark-ui/react/dialog";
import { Menu } from "@ark-ui/react/menu";
import { Portal } from "@ark-ui/react/portal";
import { Copy, MailPlus, MoreVertical, RefreshCw, Trash2, UserPlus } from "lucide-react";
import RoleGate from "@/components/RoleGate";
import Avatar from "@/components/Avatar";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { inviteUser, listTeam, removeTeamMember, type TeamMember } from "@/lib/engine";
import Spinner, { BusyLabel } from "@/components/Spinner";

type TeamRole = TeamMember["role"];

const TABS: { value: TeamRole; label: string; singular: string }[] = [
  { value: "admin", label: "Admins", singular: "admin" },
  { value: "physiatrist", label: "Physiatrists", singular: "physiatrist" },
];

export default function AdminTeamPage() {
  return (
    <RoleGate role="admin" title="Team" subtitle="The people who run Flexa and care for patients.">
      <Team />
    </RoleGate>
  );
}

async function token() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Not logged in.");
  return data.session.access_token;
}

function Team() {
  const { user } = useSession();
  const [tab, setTab] = useState<TeamRole>("admin");
  const [lists, setLists] = useState<Partial<Record<TeamRole, TeamMember[]>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState<TeamRole | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async (role: TeamRole) => {
    try {
      const members = await listTeam(await token(), role);
      setLists((prev) => ({ ...prev, [role]: members }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the team.");
    }
  }, []);

  useEffect(() => {
    load("admin");
    load("physiatrist");
  }, [load]);

  async function resend(m: TeamMember) {
    setError(null);
    setNotice(null);
    setWorking(`Sending a new code to ${m.email}...`);
    try {
      await inviteUser(await token(), m.email, m.role, m.full_name);
      setNotice(`New one-time code sent to ${m.email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend the invite.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <>
      {error && <p className="form-error" style={{ marginBottom: "1rem" }}>{error}</p>}
      {notice && <p className="form-success" style={{ marginBottom: "1rem" }}>{notice}</p>}
      {working && <p className="pending-note" style={{ marginBottom: "1rem" }}><Spinner /> {working}</p>}

      <Tabs.Root value={tab} onValueChange={(d) => setTab(d.value as TeamRole)} className="tabs">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <Tabs.List className="tab-list">
            {TABS.map((t) => (
              <Tabs.Trigger key={t.value} value={t.value} className="tab-trigger">
                {t.label}
                <span className="tab-count">{lists[t.value]?.length ?? "·"}</span>
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <button className="btn btn-sun" onClick={() => setAdding(tab)}>
            <UserPlus size={18} strokeWidth={2.8} /> Add {TABS.find((t) => t.value === tab)!.singular}
          </button>
        </div>

        {TABS.map((t) => (
          <Tabs.Content key={t.value} value={t.value} style={{ marginTop: "1.25rem" }}>
            <MemberList
              members={lists[t.value] ?? null}
              meId={user?.id}
              onResend={resend}
              onRemove={setRemoving}
              emptyText={`No ${t.label.toLowerCase()} yet.`}
            />
          </Tabs.Content>
        ))}
      </Tabs.Root>

      <AddDialog
        role={adding}
        onClose={() => setAdding(null)}
        onSent={(email, role) => {
          setNotice(`One-time code sent to ${email}.`);
          setError(null);
          load(role);
        }}
      />
      <RemoveDialog
        member={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(m) => {
          setNotice(`${m.status === "pending" ? "Invite revoked for" : "Removed"} ${m.full_name || m.email}.`);
          setError(null);
          load(m.role);
        }}
        onError={setError}
      />
    </>
  );
}

function MemberList({
  members,
  meId,
  onResend,
  onRemove,
  emptyText,
}: {
  members: TeamMember[] | null;
  meId?: string;
  onResend: (m: TeamMember) => void;
  onRemove: (m: TeamMember) => void;
  emptyText: string;
}) {
  if (!members) {
    return (
      <div className="card" style={{ overflow: "hidden" }} aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: "flex", gap: "1rem", alignItems: "center", padding: "0.9rem 1.25rem", borderTop: i ? "2px solid var(--border)" : undefined }}>
            <div className="skeleton" style={{ width: 44, height: 44 }} />
            <div style={{ flex: 1 }}>
              <div className="skeleton" style={{ height: 16, width: "40%" }} />
              <div className="skeleton" style={{ height: 12, width: "30%", marginTop: 8 }} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (members.length === 0) return <div className="card" style={{ padding: "1.5rem", color: "var(--foreground-muted)" }}>{emptyText}</div>;

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      {members.map((m, i) => {
        const isMe = m.id === meId;
        return (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "0.9rem 1.25rem", borderTop: i ? "2px solid var(--border)" : undefined }}>
            <Avatar id={m.id} name={m.full_name || m.email} size={44} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="display" style={{ fontSize: "1.1rem" }}>{m.full_name || "—"}</p>
              <p style={{ fontSize: "0.85rem", color: "var(--foreground-muted)", wordBreak: "break-all" }}>{m.email}</p>
            </div>
            {isMe && <span className="badge" style={{ background: "var(--brand-soft)", color: "var(--brand-deep)" }}>YOU</span>}
            {m.status === "pending" && (
              <span className="badge" style={{ background: "var(--sun-soft)", color: "#9a6f00" }}>
                <MailPlus size={13} strokeWidth={3} /> PENDING
              </span>
            )}
            <Menu.Root positioning={{ placement: "bottom-end" }}>
              <Menu.Trigger className="icon-btn" aria-label={`Actions for ${m.full_name || m.email}`}>
                <MoreVertical size={18} strokeWidth={2.8} />
              </Menu.Trigger>
              <Portal>
                <Menu.Positioner>
                  <Menu.Content className="select-content" style={{ minWidth: 200 }}>
                    <Menu.Item value="copy" className="select-item" onSelect={() => navigator.clipboard?.writeText(m.email)}>
                      <span className="menu-item-label"><Copy size={16} strokeWidth={2.6} /> Copy email</span>
                    </Menu.Item>
                    {m.status === "pending" && (
                      <Menu.Item value="resend" className="select-item" onSelect={() => onResend(m)}>
                        <span className="menu-item-label"><RefreshCw size={16} strokeWidth={2.6} /> Resend code</span>
                      </Menu.Item>
                    )}
                    {!isMe && (
                      <>
                        <Menu.Separator style={{ height: 2, background: "var(--border)", margin: "0.3rem 0" }} />
                        <Menu.Item value="remove" className="select-item" style={{ color: "var(--coral-deep)" }} onSelect={() => onRemove(m)}>
                          <span className="menu-item-label">
                            <Trash2 size={16} strokeWidth={2.6} /> {m.status === "pending" ? "Revoke invite" : "Remove"}
                          </span>
                        </Menu.Item>
                      </>
                    )}
                  </Menu.Content>
                </Menu.Positioner>
              </Portal>
            </Menu.Root>
          </div>
        );
      })}
    </div>
  );
}

function AddDialog({ role, onClose, onSent }: { role: TeamRole | null; onClose: () => void; onSent: (email: string, role: TeamRole) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!role) return;
    setBusy(true);
    setError(null);
    try {
      await inviteUser(await token(), email.trim(), role, name.trim());
      onSent(email.trim(), role);
      setEmail("");
      setName("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the invite.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={role !== null} onOpenChange={(d) => !d.open && onClose()} lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Positioner className="dialog-positioner">
          <Dialog.Content className="card dialog-content" style={{ width: "min(440px, 100%)", textAlign: "left" }}>
            <Dialog.Title className="display" style={{ fontSize: "1.6rem" }}>
              Add {role === "admin" ? "an admin" : "a physiatrist"}
            </Dialog.Title>
            <Dialog.Description style={{ color: "var(--foreground-muted)", margin: "0.4rem 0 1.1rem" }}>
              We email them a one-time code. They enter it on the accept-invite page, then choose a password.
            </Dialog.Description>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div className="field">
                <label htmlFor="team-name">Full name</label>
                <input id="team-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="team-email">Email</label>
                <input id="team-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              {error && <p className="form-error">{error}</p>}
              <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
                <Dialog.CloseTrigger className="btn btn-outline" type="button">Cancel</Dialog.CloseTrigger>
                <button type="submit" disabled={busy} className="btn btn-go">
                  <BusyLabel busy={busy} busyText="Sending...">Send code</BusyLabel>
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function RemoveDialog({
  member,
  onClose,
  onRemoved,
  onError,
}: {
  member: TeamMember | null;
  onClose: () => void;
  onRemoved: (m: TeamMember) => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const pending = member?.status === "pending";

  async function confirm() {
    if (!member) return;
    setBusy(true);
    try {
      await removeTeamMember(await token(), member.id);
      onRemoved(member);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not remove this person.");
    } finally {
      setBusy(false);
      onClose();
    }
  }

  return (
    <Dialog.Root open={member !== null} onOpenChange={(d) => !d.open && onClose()} role="alertdialog" lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Positioner className="dialog-positioner">
          <Dialog.Content className="card dialog-content" style={{ width: "min(440px, 100%)" }}>
            <Dialog.Title className="display" style={{ fontSize: "1.6rem" }}>
              {pending ? "Revoke this invite?" : `Remove ${member?.full_name || member?.email}?`}
            </Dialog.Title>
            <Dialog.Description style={{ color: "var(--foreground-muted)", margin: "0.6rem 0 1.5rem" }}>
              {pending
                ? "Their one-time code stops working and the pending account is deleted."
                : "They lose access immediately and their account is deleted. This can't be undone."}
            </Dialog.Description>
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
              <Dialog.CloseTrigger className="btn btn-outline" disabled={busy}>Cancel</Dialog.CloseTrigger>
              <button className="btn btn-danger" onClick={confirm} disabled={busy}>
                <BusyLabel busy={busy} busyText="Working...">{pending ? "Revoke" : "Remove"}</BusyLabel>
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

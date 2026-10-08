"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "@ark-ui/react/dialog";
import { Menu } from "@ark-ui/react/menu";
import { Portal } from "@ark-ui/react/portal";
import { Ban, CalendarDays, Copy, Eye, KeyRound, MoreVertical, Search, ShieldCheck, X } from "lucide-react";
import RoleGate from "@/components/RoleGate";
import Avatar from "@/components/Avatar";
import { supabase } from "@/lib/supabase";
import { listPatients, setPatientAccess, type PatientRecord } from "@/lib/engine";
import Spinner, { BusyLabel } from "@/components/Spinner";

export default function AdminPatientsPage() {
  return (
    <RoleGate role="admin" title="Patients" subtitle="Who is on Flexa, how they're using it, and their access.">
      <Patients />
    </RoleGate>
  );
}

async function token() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Not logged in.");
  return data.session.access_token;
}

function ago(iso: string | null): string {
  if (!iso) return "Never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

const full = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

function Patients() {
  const [patients, setPatients] = useState<PatientRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PatientRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPatients(await listPatients(await token()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load patients.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!patients) return null;
    return q ? patients.filter((p) => `${p.full_name} ${p.email}`.toLowerCase().includes(q)) : patients;
  }, [patients, query]);

  const open = patients?.find((p) => p.id === openId) ?? null;

  async function sendReset(p: PatientRecord) {
    setError(null);
    setNotice(null);
    setWorking(`Sending reset email to ${p.email}...`);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(p.email, {
      redirectTo: `${window.location.origin}/accept-invite`,
    });
    setWorking(null);
    if (resetError) setError(resetError.message);
    else setNotice(`Password reset email sent to ${p.email}.`);
  }

  async function toggleAccess() {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      await setPatientAccess(await token(), confirm.id, !confirm.suspended);
      setNotice(`${confirm.full_name || confirm.email} ${confirm.suspended ? "can sign in again" : "is suspended"}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update access.");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  return (
    <>
      {error && <p className="form-error" style={{ marginBottom: "1rem" }}>{error}</p>}
      {notice && <p className="form-success" style={{ marginBottom: "1rem" }}>{notice}</p>}
      {working && <p className="pending-note" style={{ marginBottom: "1rem" }}><Spinner /> {working}</p>}

      <div className="search-box">
        <Search size={18} strokeWidth={2.8} />
        <input placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search patients" />
      </div>

      <div className="card" style={{ overflow: "hidden" }} aria-busy={shown === null}>
        {shown === null &&
          [0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", gap: "1rem", alignItems: "center", padding: "0.9rem 1.25rem", borderTop: i ? "2px solid var(--border)" : undefined }}>
              <div className="skeleton" style={{ width: 44, height: 44 }} />
              <div style={{ flex: 1 }}>
                <div className="skeleton" style={{ height: 16, width: "40%" }} />
                <div className="skeleton" style={{ height: 12, width: "30%", marginTop: 8 }} />
              </div>
            </div>
          ))}
        {shown?.length === 0 && (
          <p style={{ padding: "1.5rem", color: "var(--foreground-muted)" }}>{query ? "No patients match your search." : "No patients yet."}</p>
        )}
        {shown?.map((p, i) => (
          <div key={p.id} className="patient-row" style={{ borderTop: i ? "2px solid var(--border)" : undefined }}>
            <button type="button" className="patient-main" onClick={() => setOpenId(p.id)}>
              <Avatar id={p.id} name={p.full_name || p.email} size={44} />
              <span style={{ minWidth: 0, textAlign: "left", flex: 1 }}>
                <span className="display" style={{ fontSize: "1.1rem", display: "block" }}>{p.full_name || "—"}</span>
                <span style={{ fontSize: "0.85rem", color: "var(--foreground-muted)", wordBreak: "break-all" }}>{p.email}</span>
              </span>
              <span className="patient-meta">
                <span>Last seen <b>{ago(p.last_sign_in_at)}</b></span>
                <span><b>{p.rounds}</b> rounds</span>
              </span>
            </button>
            {p.suspended ? (
              <span className="badge" style={{ background: "var(--coral-soft)", color: "var(--coral-deep)" }}><Ban size={13} strokeWidth={3} /> SUSPENDED</span>
            ) : (
              <span className="badge" style={{ background: "var(--mint-soft)", color: "var(--mint-deep)" }}>ACTIVE</span>
            )}
            <Menu.Root positioning={{ placement: "bottom-end" }}>
              <Menu.Trigger className="icon-btn" aria-label={`Actions for ${p.full_name || p.email}`}>
                <MoreVertical size={18} strokeWidth={2.8} />
              </Menu.Trigger>
              <Portal>
                <Menu.Positioner>
                  <Menu.Content className="select-content" style={{ minWidth: 220 }}>
                    <Menu.Item value="view" className="select-item" onSelect={() => setOpenId(p.id)}>
                      <span className="menu-item-label"><Eye size={16} strokeWidth={2.6} /> View details</span>
                    </Menu.Item>
                    <Menu.Item value="copy" className="select-item" onSelect={() => navigator.clipboard?.writeText(p.email)}>
                      <span className="menu-item-label"><Copy size={16} strokeWidth={2.6} /> Copy email</span>
                    </Menu.Item>
                    <Menu.Item value="reset" className="select-item" onSelect={() => sendReset(p)}>
                      <span className="menu-item-label"><KeyRound size={16} strokeWidth={2.6} /> Send password reset</span>
                    </Menu.Item>
                    <Menu.Separator style={{ height: 2, background: "var(--border)", margin: "0.3rem 0" }} />
                    <Menu.Item
                      value="access"
                      className="select-item"
                      style={{ color: p.suspended ? "var(--mint-deep)" : "var(--coral-deep)" }}
                      onSelect={() => setConfirm(p)}
                    >
                      <span className="menu-item-label">
                        {p.suspended ? <ShieldCheck size={16} strokeWidth={2.6} /> : <Ban size={16} strokeWidth={2.6} />}
                        {p.suspended ? "Restore access" : "Suspend access"}
                      </span>
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Positioner>
              </Portal>
            </Menu.Root>
          </div>
        ))}
      </div>

      <Dialog.Root open={open !== null} onOpenChange={(d) => !d.open && setOpenId(null)} lazyMount unmountOnExit>
        <Portal>
          <Dialog.Backdrop className="dialog-backdrop" />
          <Dialog.Positioner className="drawer-positioner">
            <Dialog.Content className="drawer">
              {open && <PatientDetail p={open} onClose={() => setOpenId(null)} onReset={() => sendReset(open)} onAccess={() => setConfirm(open)} />}
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <Dialog.Root open={confirm !== null} onOpenChange={(d) => !d.open && setConfirm(null)} role="alertdialog" lazyMount unmountOnExit>
        <Portal>
          <Dialog.Backdrop className="dialog-backdrop" style={{ zIndex: 70 }} />
          <Dialog.Positioner className="dialog-positioner" style={{ zIndex: 71 }}>
            <Dialog.Content className="card dialog-content" style={{ width: "min(440px, 100%)" }}>
              <Dialog.Title className="display" style={{ fontSize: "1.6rem" }}>
                {confirm?.suspended ? "Restore access?" : "Suspend access?"}
              </Dialog.Title>
              <Dialog.Description style={{ color: "var(--foreground-muted)", margin: "0.6rem 0 1.5rem" }}>
                {confirm?.suspended
                  ? `${confirm.full_name || confirm.email} will be able to sign in again.`
                  : `${confirm?.full_name || confirm?.email} won't be able to sign in. Their data is kept, and a session that's already open lasts until it expires.`}
              </Dialog.Description>
              <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
                <Dialog.CloseTrigger className="btn btn-outline" disabled={busy}>Cancel</Dialog.CloseTrigger>
                <button className={confirm?.suspended ? "btn btn-go" : "btn btn-danger"} onClick={toggleAccess} disabled={busy}>
                  <BusyLabel busy={busy} busyText="Working...">{confirm?.suspended ? "Restore" : "Suspend"}</BusyLabel>
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <span className="field-label" style={{ margin: 0, fontSize: "0.7rem" }}>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function PatientDetail({ p, onClose, onReset, onAccess }: { p: PatientRecord; onClose: () => void; onReset: () => void; onAccess: () => void }) {
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <Avatar id={p.id} name={p.full_name || p.email} size={72} />
        <Dialog.CloseTrigger className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={20} strokeWidth={2.8} />
        </Dialog.CloseTrigger>
      </div>
      <Dialog.Title className="display" style={{ fontSize: "1.8rem", marginTop: "0.75rem" }}>{p.full_name || "Unnamed patient"}</Dialog.Title>
      <Dialog.Description style={{ color: "var(--foreground-muted)", wordBreak: "break-all" }}>{p.email}</Dialog.Description>

      <h3 className="drawer-h">Access</h3>
      <div className="fact-grid">
        <Fact label="Status" value={p.suspended ? "Suspended" : "Active"} />
        <Fact label="Last sign-in" value={full(p.last_sign_in_at)} />
        <Fact label="Joined" value={new Date(p.joined_at).toLocaleDateString()} />
      </div>

      <h3 className="drawer-h">Activity</h3>
      <div className="fact-grid">
        <Fact label="Rounds played" value={String(p.rounds)} />
        <Fact label="Last round" value={ago(p.last_round_at)} />
        <Fact label="Active days (30d)" value={`${p.active_days_30} of 30`} />
        <Fact label="Avg accuracy" value={pct(p.avg_accuracy)} />
      </div>
      <p className="chart-sub" style={{ marginTop: "0.6rem" }}>
        <CalendarDays size={13} strokeWidth={2.8} style={{ verticalAlign: "-2px" }} /> Activity counts rounds played. Flexa doesn&apos;t track page views.
      </p>

      <h3 className="drawer-h">Care team</h3>
      {p.physiatrists.length === 0 ? (
        <p className="chart-sub">No physiatrist assigned.</p>
      ) : (
        <div className="chip-row">{p.physiatrists.map((d) => <span key={d.id} className="chip"><b>{d.name}</b></span>)}</div>
      )}

      <h3 className="drawer-h">Prescribed games</h3>
      {p.prescribed_exercises.length === 0 ? (
        <p className="chart-sub">Nothing prescribed yet.</p>
      ) : (
        <div className="chip-row">{p.prescribed_exercises.map((n) => <span key={n} className="chip"><b>{n}</b></span>)}</div>
      )}

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "1.75rem" }}>
        <button className="btn btn-outline btn-sm" onClick={onReset}><KeyRound size={15} strokeWidth={2.8} /> Password reset</button>
        <button className={`btn btn-sm ${p.suspended ? "btn-go" : "btn-danger"}`} onClick={onAccess}>
          {p.suspended ? <ShieldCheck size={15} strokeWidth={2.8} /> : <Ban size={15} strokeWidth={2.8} />}
          {p.suspended ? "Restore access" : "Suspend access"}
        </button>
      </div>
    </>
  );
}

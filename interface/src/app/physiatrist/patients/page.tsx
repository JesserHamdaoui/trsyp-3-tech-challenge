"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Dialog } from "@ark-ui/react/dialog";
import { Menu } from "@ark-ui/react/menu";
import { Portal } from "@ark-ui/react/portal";
import { Copy, Eye, MoreVertical, Pill, Search, UserMinus, UserPlus, X } from "lucide-react";
import RoleGate from "@/components/RoleGate";
import Avatar from "@/components/Avatar";
import InviteForm from "@/components/InviteForm";
import Spinner, { BusyLabel } from "@/components/Spinner";
import { StatusBadge, TrendChip, ago, pct, token } from "@/components/care/shared";
import { listCarePatients, listExercises, unassignPatient, type CarePatient, type Exercise } from "@/lib/engine";

export default function PhysiatristPatientsPage() {
  return (
    <RoleGate role="physiatrist" title="My patients" subtitle="Everyone in your care, and who needs you.">
      <Patients />
    </RoleGate>
  );
}

const FILTERS = [
  { value: "all", label: "All" },
  { value: "needs_attention", label: "Needs attention" },
  { value: "on_track", label: "On track" },
  { value: "new", label: "New" },
] as const;

function Patients() {
  const [patients, setPatients] = useState<CarePatient[] | null>(null);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<CarePatient | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPatients(await listCarePatients(await token()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load patients.");
    }
  }, []);

  useEffect(() => {
    load();
    listExercises().then(setExercises).catch(() => {});
  }, [load]);

  const exName = (id: string) => exercises.find((e) => e.exercise_id === id)?.display_name ?? id;

  const shown = useMemo(() => {
    if (!patients) return null;
    const q = query.trim().toLowerCase();
    return patients
      .filter((p) => filter === "all" || p.status === filter)
      .filter((p) => !q || `${p.full_name} ${p.email}`.toLowerCase().includes(q));
  }, [patients, query, filter]);

  const counts = (v: string) => (patients ? (v === "all" ? patients.length : patients.filter((p) => p.status === v).length) : "·");

  async function remove() {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      await unassignPatient(await token(), confirm.id);
      setNotice(`${confirm.full_name || confirm.email} was removed from your patients.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the patient.");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  return (
    <>
      {error && <p className="form-error" style={{ marginBottom: "1rem" }}>{error}</p>}
      {notice && <p className="form-success" style={{ marginBottom: "1rem" }}>{notice}</p>}

      <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap", marginBottom: "1rem" }}>
        <div className="search-box" style={{ flex: "1 1 260px", margin: 0 }}>
          <Search size={18} strokeWidth={2.8} />
          <input placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search patients" />
        </div>
        <button className="btn btn-sun" onClick={() => setAdding(true)}>
          <UserPlus size={18} strokeWidth={2.8} /> Add patient
        </button>
      </div>

      <div className="chip-row" style={{ marginBottom: "1rem" }} role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`btn btn-sm ${filter === f.value ? "btn-sun" : "btn-outline"}`}
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label} <b>{counts(f.value)}</b>
          </button>
        ))}
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
          <p style={{ padding: "1.5rem", color: "var(--foreground-muted)" }}>
            {patients?.length === 0 ? "No patients yet. Use Add patient to invite one." : "No patients match."}
          </p>
        )}
        {shown?.map((p, i) => (
          <div key={p.id} className="patient-row" style={{ borderTop: i ? "2px solid var(--border)" : undefined }}>
            <Link href={`/physiatrist/patients/${p.id}`} className="patient-main" style={{ textDecoration: "none", color: "inherit" }}>
              <Avatar id={p.id} name={p.full_name || p.email} size={44} />
              <span style={{ minWidth: 0, textAlign: "left", flex: 1 }}>
                <span className="display" style={{ fontSize: "1.1rem", display: "block" }}>{p.full_name || "—"}</span>
                <span style={{ fontSize: "0.85rem", color: "var(--foreground-muted)", wordBreak: "break-all" }}>{p.email}</span>
                {p.reasons[0] && (
                  <span style={{ display: "block", fontSize: "0.82rem", fontWeight: 700, color: "var(--coral-deep)" }}>{p.reasons[0].text}</span>
                )}
                {p.prescriptions.length > 0 && (
                  <span style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.3rem" }}>
                    {p.prescriptions.map((id) => <span key={id} className="chip"><b>{exName(id)}</b></span>)}
                  </span>
                )}
              </span>
              <span className="patient-meta">
                <span>Last round <b>{ago(p.last_round_at)}</b></span>
                <span>Accuracy <b>{pct(p.recent_accuracy)}</b></span>
                <span><b>{p.rounds_7d}</b> this week</span>
              </span>
            </Link>
            <TrendChip trend={p.trend} />
            <StatusBadge status={p.status} />
            <Menu.Root positioning={{ placement: "bottom-end" }}>
              <Menu.Trigger className="icon-btn" aria-label={`Actions for ${p.full_name || p.email}`}>
                <MoreVertical size={18} strokeWidth={2.8} />
              </Menu.Trigger>
              <Portal>
                <Menu.Positioner>
                  <Menu.Content className="select-content" style={{ minWidth: 220 }}>
                    <Menu.Item value="open" className="select-item" asChild>
                      <Link href={`/physiatrist/patients/${p.id}`}>
                        <span className="menu-item-label"><Eye size={16} strokeWidth={2.6} /> Open</span>
                      </Link>
                    </Menu.Item>
                    <Menu.Item value="rx" className="select-item" asChild>
                      <Link href={`/physiatrist/patients/${p.id}?tab=prescriptions`}>
                        <span className="menu-item-label"><Pill size={16} strokeWidth={2.6} /> Prescriptions</span>
                      </Link>
                    </Menu.Item>
                    <Menu.Item value="copy" className="select-item" onSelect={() => navigator.clipboard?.writeText(p.email)}>
                      <span className="menu-item-label"><Copy size={16} strokeWidth={2.6} /> Copy email</span>
                    </Menu.Item>
                    <Menu.Separator style={{ height: 2, background: "var(--border)", margin: "0.3rem 0" }} />
                    <Menu.Item value="remove" className="select-item" style={{ color: "var(--coral-deep)" }} onSelect={() => setConfirm(p)}>
                      <span className="menu-item-label"><UserMinus size={16} strokeWidth={2.6} /> Remove from my patients</span>
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Positioner>
              </Portal>
            </Menu.Root>
          </div>
        ))}
      </div>

      <Dialog.Root open={adding} onOpenChange={(d) => !d.open && setAdding(false)} lazyMount unmountOnExit>
        <Portal>
          <Dialog.Backdrop className="dialog-backdrop" />
          <Dialog.Positioner className="dialog-positioner">
            <Dialog.Content className="card dialog-content" style={{ width: "min(480px, 100%)", textAlign: "left" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Dialog.Title className="display" style={{ fontSize: "1.5rem" }}>Add a patient</Dialog.Title>
                <Dialog.CloseTrigger className="icon-btn" aria-label="Close" onClick={load}><X size={20} strokeWidth={2.8} /></Dialog.CloseTrigger>
              </div>
              <Dialog.Description style={{ color: "var(--foreground-muted)", margin: "0.4rem 0 1rem" }}>
                They get an email invite and join your care team when they accept.
              </Dialog.Description>
              <InviteForm heading="New patient" roleOptions={[{ value: "patient", label: "Patient" }]} />
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <Dialog.Root open={confirm !== null} onOpenChange={(d) => !d.open && setConfirm(null)} role="alertdialog" lazyMount unmountOnExit>
        <Portal>
          <Dialog.Backdrop className="dialog-backdrop" />
          <Dialog.Positioner className="dialog-positioner">
            <Dialog.Content className="card dialog-content" style={{ width: "min(440px, 100%)" }}>
              <Dialog.Title className="display" style={{ fontSize: "1.6rem" }}>Remove patient?</Dialog.Title>
              <Dialog.Description style={{ color: "var(--foreground-muted)", margin: "0.6rem 0 1.5rem" }}>
                {confirm?.full_name || confirm?.email} will no longer be in your care list and you won&apos;t see their data. Their account, rounds and prescriptions are kept.
              </Dialog.Description>
              <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
                <Dialog.CloseTrigger className="btn btn-outline" disabled={busy}>Cancel</Dialog.CloseTrigger>
                <button className="btn btn-danger" onClick={remove} disabled={busy}>
                  <BusyLabel busy={busy} busyText="Removing...">Remove</BusyLabel>
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

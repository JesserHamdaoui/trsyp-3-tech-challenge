"use client";

import { useMemo, useState } from "react";
import { Collapsible } from "@ark-ui/react/collapsible";
import { Dialog } from "@ark-ui/react/dialog";
import { Menu } from "@ark-ui/react/menu";
import { Portal } from "@ark-ui/react/portal";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  Download,
  Fingerprint,
  MoreVertical,
  ScanEye,
  Target,
  Trash2,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { QualityReport, ReferenceSummary } from "@/lib/engine";
import Spinner, { BusyLabel } from "./Spinner";

const VERDICT: Record<QualityReport["verdict"], { label: string; icon: LucideIcon; bg: string; fg: string }> = {
  good: { label: "Good", icon: CheckCircle2, bg: "var(--mint-soft)", fg: "var(--mint-deep)" },
  review: { label: "Review", icon: AlertTriangle, bg: "var(--sun-soft)", fg: "#9a6f00" },
  poor: { label: "Poor", icon: XCircle, bg: "var(--coral-soft)", fg: "var(--coral-deep)" },
};

const FINGER_COLOR: Record<string, string> = {
  thumb: "var(--sun)",
  index: "var(--sky)",
  middle: "var(--mint)",
  ring: "var(--lilac)",
  pinky: "var(--coral)",
};

const KNOWN_META = new Set(["level_id", "note_index", "source_file", "target_finger"]);

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);

export function ReferenceSkeletons({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card" style={{ padding: "0.9rem 1.1rem", display: "flex", gap: "0.9rem", alignItems: "center" }} aria-hidden="true">
          <div className="skeleton" style={{ height: 20, width: 20 }} />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 18, width: "55%" }} />
            <div className="skeleton" style={{ height: 12, width: "35%", marginTop: 10 }} />
          </div>
          <div className="skeleton" style={{ height: 24, width: 64, borderRadius: 999 }} />
        </div>
      ))}
    </>
  );
}

function VerdictBadge({ verdict }: { verdict: QualityReport["verdict"] }) {
  const v = VERDICT[verdict];
  const Icon = v.icon;
  return (
    <span className="badge" style={{ background: v.bg, color: v.fg }}>
      <Icon size={14} strokeWidth={3} /> {v.label.toUpperCase()}
    </span>
  );
}

/** A metric with an optional bar. `good` says which side of `threshold` passes. */
function Metric({
  icon: Icon,
  label,
  value,
  hint,
  bar,
  threshold,
  passes,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
  bar?: number | null;
  threshold?: number;
  passes?: boolean | null;
}) {
  const color = passes == null ? "var(--brand)" : passes ? "var(--mint-deep)" : "var(--coral-deep)";
  return (
    <div className="metric">
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", color: "var(--foreground-muted)" }}>
        <Icon size={16} strokeWidth={2.6} />
        <span className="field-label" style={{ margin: 0, fontSize: "0.7rem" }}>{label}</span>
      </div>
      <p className="display" style={{ fontSize: "1.7rem", color, margin: "0.15rem 0 0.45rem" }}>{value}</p>
      {bar != null && (
        <div className="meter" aria-hidden="true">
          <div className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, bar * 100))}%`, background: color }} />
          {threshold != null && <div className="meter-mark" style={{ left: `${threshold * 100}%` }} />}
        </div>
      )}
      <p style={{ fontSize: "0.78rem", color: "var(--foreground-muted)", marginTop: "0.4rem" }}>{hint}</p>
    </div>
  );
}

function Chip({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="chip">
      {color && <span className="chip-dot" style={{ background: color }} />}
      <span className="chip-label">{label}</span>
      <b>{value}</b>
    </span>
  );
}

function Details({ r }: { r: ReferenceSummary }) {
  const q = r.quality;
  const source = typeof r.meta.source_file === "string" ? r.meta.source_file : null;
  const extra = Object.entries(r.meta).filter(([k]) => !KNOWN_META.has(k));
  const targetOk = q.target_peak_curl == null ? null : q.target_peak_curl >= 0.65;
  const isoOk = q.isolation_peak == null ? null : q.isolation_peak <= 0.35;

  return (
    <div style={{ padding: "0 1.1rem 1.1rem", display: "flex", flexDirection: "column", gap: "0.9rem" }}>
      {q.issues.length > 0 ? (
        <ul className="issue-list">
          {q.issues.map((issue) => (
            <li key={issue}>
              <AlertTriangle size={16} strokeWidth={2.8} /> {issue}
            </li>
          ))}
        </ul>
      ) : (
        <p className="form-success" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <CheckCircle2 size={16} strokeWidth={3} /> Clean recording. No issues found.
        </p>
      )}

      <div className="metric-grid">
        <Metric
          icon={ScanEye}
          label="Hand tracking"
          value={pct(q.detection_rate)}
          bar={q.detection_rate}
          threshold={0.8}
          passes={q.detection_rate >= 0.8}
          hint={`${q.detected_frames} of ${q.frame_count} frames`}
        />
        {q.target_peak_curl != null ? (
          <Metric
            icon={Target}
            label={`${q.target_finger ?? "Target"} curl`}
            value={pct(q.target_peak_curl)}
            bar={q.target_peak_curl}
            threshold={0.65}
            passes={targetOk}
            hint="Peak. Needs 65% or more"
          />
        ) : (
          <Metric
            icon={Target}
            label="Note accuracy"
            value={pct(q.accuracy)}
            bar={q.accuracy}
            threshold={0.7}
            passes={q.accuracy == null ? null : q.accuracy >= 0.7}
            hint={q.accuracy == null ? "No game stats saved" : "Clean hits. Aim for 70%+"}
          />
        )}
        <Metric
          icon={Fingerprint}
          label="Isolation"
          value={pct(q.isolation_peak)}
          bar={q.isolation_peak}
          threshold={0.35}
          passes={isoOk}
          hint={q.isolation_peak == null ? "Needs a target finger" : "Other fingers' peak. Keep 35% or less"}
        />
        <Metric
          icon={Clock}
          label="Capture"
          value={q.duration_ms == null ? "—" : `${(q.duration_ms / 1000).toFixed(1)}s`}
          passes={q.fps == null ? null : q.fps >= 15}
          hint={q.fps == null ? "No timestamps" : `${q.fps} fps`}
        />
      </div>

      <div className="chip-row">
        {typeof r.meta.level_id !== "undefined" && <Chip label="Level" value={String(r.meta.level_id)} />}
        {typeof r.meta.note_index !== "undefined" && <Chip label="Note" value={String(r.meta.note_index)} />}
        {q.target_finger && <Chip label="Target" value={q.target_finger} color={FINGER_COLOR[q.target_finger]} />}
        <Chip label="Exercise" value={r.exercise_id} />
        {extra.map(([k, v]) => (
          <Chip key={k} label={k.replace(/_/g, " ")} value={typeof v === "object" ? JSON.stringify(v) : String(v)} />
        ))}
      </div>

      {source && (
        <div className="source-line">
          <Zap size={14} strokeWidth={2.8} />
          <code title={source}>{source}</code>
          <button type="button" className="icon-btn" aria-label="Copy source file name" onClick={() => navigator.clipboard?.writeText(source)}>
            <Copy size={14} strokeWidth={2.8} />
          </button>
        </div>
      )}
    </div>
  );
}

function RowMenu({ onExport, onDelete, onCopyId }: { onExport: () => void; onDelete: () => void; onCopyId: () => void }) {
  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger className="icon-btn" aria-label="More actions" onClick={(e) => e.stopPropagation()}>
        <MoreVertical size={18} strokeWidth={2.8} />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content className="select-content" style={{ minWidth: 190 }}>
            <Menu.Item value="export" className="select-item" onSelect={onExport}>
              <span className="menu-item-label"><Download size={16} strokeWidth={2.6} /> Export JSON</span>
            </Menu.Item>
            <Menu.Item value="copy" className="select-item" onSelect={onCopyId}>
              <span className="menu-item-label"><Copy size={16} strokeWidth={2.6} /> Copy ID</span>
            </Menu.Item>
            <Menu.Separator style={{ height: 2, background: "var(--border)", margin: "0.3rem 0" }} />
            <Menu.Item value="delete" className="select-item" style={{ color: "var(--coral-deep)" }} onSelect={onDelete}>
              <span className="menu-item-label"><Trash2 size={16} strokeWidth={2.6} /> Delete</span>
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

/** Scrollable, selectable list of reference attempts with quality details. */
export default function ReferenceList({
  references,
  nameFor,
  onExport,
  onDelete,
}: {
  /** null = still loading */
  references: ReferenceSummary[] | null;
  nameFor: (exerciseId: string) => string;
  onExport: (ids: number[]) => Promise<void>;
  onDelete: (ids: number[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function runExport(ids: number[]) {
    setExporting(true);
    try {
      await onExport(ids);
    } finally {
      setExporting(false);
    }
  }

  const ids = useMemo(() => references?.map((r) => r.id) ?? [], [references]);
  const selectedIds = ids.filter((id) => selected.has(id));
  const allSelected = ids.length > 0 && selectedIds.length === ids.length;

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function confirmDelete() {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await onDelete(pendingDelete);
      setSelected((prev) => new Set([...prev].filter((id) => !pendingDelete.includes(id))));
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  }

  return (
    <>
      {references && references.length > 0 && (
        <div className="bulk-bar">
          <label className="check-label">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(ids))}
              aria-label="Select all references"
            />
            {selectedIds.length > 0 ? `${selectedIds.length} selected` : "Select all"}
          </label>
          {selectedIds.length > 0 && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="btn btn-outline btn-sm" disabled={busy || exporting} onClick={() => runExport(selectedIds)}>
                {exporting ? <Spinner size={15} /> : <Download size={15} strokeWidth={2.8} />} Export
              </button>
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => setPendingDelete(selectedIds)}>
                <Trash2 size={15} strokeWidth={2.8} /> Delete
              </button>
            </div>
          )}
        </div>
      )}

      <div className="scroll-list" role="region" aria-label="Uploaded references" aria-busy={references === null}>
        {references === null && <ReferenceSkeletons />}
        {references?.length === 0 && <p className="muted-on-dark">None yet.</p>}
        {references?.map((r) => (
          <Collapsible.Root key={r.id} className="card ref-row" data-selected={selected.has(r.id)}>
            <div className="ref-head">
              <input
                type="checkbox"
                checked={selected.has(r.id)}
                onChange={() => toggle(r.id)}
                aria-label={`Select reference ${r.id}`}
              />
              <Collapsible.Trigger className="ref-trigger">
                <div style={{ textAlign: "left", minWidth: 0 }}>
                  <p className="display" style={{ fontSize: "1.05rem" }}>{nameFor(r.exercise_id)}</p>
                  <p style={{ fontSize: "0.82rem", color: "var(--foreground-muted)" }}>
                    #{r.id} · {r.frame_count} frames · {new Date(r.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="ref-badges">
                  {r.quality.target_finger && (
                    <Chip label="" value={r.quality.target_finger} color={FINGER_COLOR[r.quality.target_finger]} />
                  )}
                  <VerdictBadge verdict={r.quality.verdict} />
                </div>
                <Collapsible.Indicator className="ref-chevron">
                  <ChevronDown size={20} strokeWidth={3} />
                </Collapsible.Indicator>
              </Collapsible.Trigger>
              <RowMenu
                onExport={() => runExport([r.id])}
                onCopyId={() => navigator.clipboard?.writeText(String(r.id))}
                onDelete={() => setPendingDelete([r.id])}
              />
            </div>
            <Collapsible.Content className="ref-content">
              <Details r={r} />
            </Collapsible.Content>
          </Collapsible.Root>
        ))}
      </div>

      <Dialog.Root open={pendingDelete !== null} onOpenChange={(d) => !d.open && setPendingDelete(null)} role="alertdialog" lazyMount unmountOnExit>
        <Portal>
          <Dialog.Backdrop className="dialog-backdrop" />
          <Dialog.Positioner className="dialog-positioner">
            <Dialog.Content className="card dialog-content" style={{ width: "min(440px, 100%)" }}>
              <Dialog.Title className="display" style={{ fontSize: "1.6rem" }}>
                Delete {pendingDelete?.length === 1 ? "this reference" : `${pendingDelete?.length} references`}?
              </Dialog.Title>
              <Dialog.Description style={{ color: "var(--foreground-muted)", margin: "0.6rem 0 1.5rem" }}>
                This permanently removes the recorded frames. Patient scoring can no longer use
                {pendingDelete?.length === 1 ? " it" : " them"}. This can&apos;t be undone.
              </Dialog.Description>
              <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
                <Dialog.CloseTrigger className="btn btn-outline" disabled={busy}>Cancel</Dialog.CloseTrigger>
                <button className="btn btn-danger" onClick={confirmDelete} disabled={busy}>
                  <BusyLabel busy={busy} busyText="Deleting...">Delete</BusyLabel>
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

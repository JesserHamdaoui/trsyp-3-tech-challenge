"use client";

import { ArrowDown, ArrowRight, ArrowUp, CircleCheck, Sparkles, TriangleAlert } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { CarePatient } from "@/lib/engine";

export async function token() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Not logged in.");
  return data.session.access_token;
}

export function ago(iso: string | null): string {
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

export const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card stat-tile">
      <p className="field-label" style={{ margin: 0 }}>{label}</p>
      <p className="stat-value">{value}</p>
      {note && <p className="stat-note">{note}</p>}
    </div>
  );
}

const STATUS = {
  needs_attention: { label: "NEEDS ATTENTION", bg: "var(--coral-soft)", fg: "var(--coral-deep)", Icon: TriangleAlert },
  on_track: { label: "ON TRACK", bg: "var(--mint-soft)", fg: "var(--mint-deep)", Icon: CircleCheck },
  new: { label: "NEW", bg: "var(--sky-soft)", fg: "var(--sky-deep)", Icon: Sparkles },
} as const;

export function StatusBadge({ status }: { status: CarePatient["status"] }) {
  const s = STATUS[status];
  return (
    <span className="badge" style={{ background: s.bg, color: s.fg }}>
      <s.Icon size={13} strokeWidth={3} /> {s.label}
    </span>
  );
}

const TREND = {
  improving: { text: "Improving", Icon: ArrowUp, tone: "good" },
  declining: { text: "Declining", Icon: ArrowDown, tone: "bad" },
  plateau: { text: "Steady", Icon: ArrowRight, tone: "same" },
  building: { text: "Too early", Icon: ArrowRight, tone: "same" },
} as const;

export function TrendChip({ trend }: { trend: CarePatient["trend"] }) {
  const t = TREND[trend];
  return (
    <span className="delta" data-tone={t.tone}>
      <t.Icon size={13} strokeWidth={3} /> {t.text}
    </span>
  );
}

export const SEVERITY_COLOR = { high: "var(--coral-deep)", medium: "var(--sun-deep)", low: "var(--foreground-muted)" } as const;

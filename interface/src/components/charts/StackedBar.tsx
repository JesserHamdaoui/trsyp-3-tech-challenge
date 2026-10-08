"use client";

import { useState } from "react";
import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";

export interface Segment {
  label: string;
  value: number;
  color: string;
  icon: "good" | "warning" | "critical";
}

const ICON = { good: CheckCircle2, warning: AlertTriangle, critical: XCircle };

/** One part-to-whole bar. Status colors carry meaning, so each segment also has an icon + label in the legend. */
export default function StackedBar({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const [hover, setHover] = useState<number | null>(null);
  if (total === 0) return <p className="chart-empty">No scored rounds in this range.</p>;

  return (
    <div>
      <div className="stack" role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join(", ")}>
        {segments.map((s, i) =>
          s.value > 0 ? (
            <span
              key={s.label}
              className="stack-seg"
              style={{ flex: s.value, background: s.color, opacity: hover == null || hover === i ? 1 : 0.55 }}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              title={`${s.label}: ${s.value} (${Math.round((s.value / total) * 100)}%)`}
            />
          ) : null
        )}
      </div>
      <ul className="legend">
        {segments.map((s) => {
          const Icon = ICON[s.icon];
          return (
            <li key={s.label}>
              <i className="legend-swatch" style={{ background: s.color }} />
              <Icon size={14} strokeWidth={2.8} />
              <span>{s.label}</span>
              <b>{s.value.toLocaleString()}</b>
              <span className="chart-sub">{Math.round((s.value / total) * 100)}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

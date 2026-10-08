"use client";

import { useState } from "react";

export interface BarItem {
  label: string;
  value: number;
  /** text at the bar tip */
  display: string;
  /** extra tooltip lines */
  detail?: string[];
}

/** Horizontal bars, one per category, sorted by the caller. Single color: the
 * bar length carries the value, the label carries identity. */
export default function BarList({ items, color, max }: { items: BarItem[]; color: string; max?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = max ?? Math.max(1, ...items.map((i) => i.value));

  if (items.length === 0) return <p className="chart-empty">No data in this range.</p>;

  return (
    <ul className="bar-list">
      {items.map((it, i) => (
        <li
          key={it.label}
          className="bar-row"
          data-hover={hover === i}
          tabIndex={0}
          onPointerEnter={() => setHover(i)}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(i)}
          onBlur={() => setHover(null)}
        >
          <span className="bar-label" title={it.label}>{it.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${Math.max(it.value > 0 ? 1.5 : 0, (it.value / top) * 100)}%`, background: color }} />
          </span>
          <span className="bar-value">{it.display}</span>
          {hover === i && it.detail && (
            <span className="tooltip bar-tooltip">
              <b>{it.display}</b>
              <span className="tooltip-row">
                <i className="tooltip-key" style={{ background: color }} />
                {it.label}
              </span>
              {it.detail.map((d) => (
                <span key={d} className="tooltip-date">{d}</span>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

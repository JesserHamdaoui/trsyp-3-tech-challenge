"use client";

import { useRef, useState } from "react";

export interface LinePoint {
  label: string;
  /** null = no data that day: the line breaks instead of dropping to zero */
  value: number | null;
}

const W = 640;
const H = 240;
const PAD = { l: 44, r: 20, t: 14, b: 28 };

/** Single-series line over a time axis with a snapping crosshair + tooltip. */
export default function LineChart({
  points,
  color,
  format,
  yMax,
  seriesName,
}: {
  points: LinePoint[];
  color: string;
  format: (v: number) => string;
  /** fixed y max (e.g. 1 for a ratio); defaults to a rounded-up data max */
  yMax?: number;
  seriesName: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const values = points.map((p) => p.value ?? 0);
  const top = yMax ?? niceCeil(Math.max(1, ...values));
  const x = (i: number) => PAD.l + (points.length === 1 ? 0 : (i / (points.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);

  // runs of consecutive non-null points -> separate path segments
  const runs: { i: number; v: number }[][] = [];
  points.forEach((p, i) => {
    if (p.value == null) return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1].i === i - 1) last.push({ i, v: p.value });
    else runs.push([{ i, v: p.value }]);
  });

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const labelEvery = Math.ceil(points.length / 6);
  const last = [...points].reverse().findIndex((p) => p.value != null);
  const lastIdx = last === -1 ? null : points.length - 1 - last;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  }

  const hp = hover != null ? points[hover] : null;

  return (
    <div className="chart-wrap">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${seriesName} over time`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        style={{ touchAction: "none" }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="grid-line" />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="axis-text">
              {format(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <text key={`${i}-${p.label}`} x={x(i)} y={H - 8} textAnchor="middle" className="axis-text">
              {shortDate(p.label)}
            </text>
          ) : null
        )}

        {runs.map((run, k) =>
          run.length > 1 ? (
            <g key={k}>
              <path d={`${path(run, x, y)} L${x(run[run.length - 1].i)},${y(0)} L${x(run[0].i)},${y(0)} Z`} fill={color} opacity={0.1} />
              <path d={path(run, x, y)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ) : null
        )}
        {/* isolated single-day points still need a mark */}
        {runs.filter((r) => r.length === 1).map((r) => (
          <circle key={r[0].i} cx={x(r[0].i)} cy={y(r[0].v)} r={4} fill={color} className="dot-ring" />
        ))}
        {lastIdx != null && (
          <circle cx={x(lastIdx)} cy={y(points[lastIdx].value!)} r={4.5} fill={color} className="dot-ring" />
        )}

        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="crosshair" />
            {hp?.value != null && <circle cx={x(hover)} cy={y(hp.value)} r={5} fill={color} className="dot-ring" />}
          </g>
        )}
      </svg>
      {hp && hover != null && (
        <div className="tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <b>{hp.value == null ? "No data" : format(hp.value)}</b>
          <span className="tooltip-row">
            <i className="tooltip-key" style={{ background: color }} />
            {seriesName}
          </span>
          <span className="tooltip-date">{fullDate(hp.label)}</span>
        </div>
      )}
    </div>
  );
}

function path(run: { i: number; v: number }[], x: (i: number) => number, y: (v: number) => number) {
  return run.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
}

function niceCeil(n: number) {
  if (n <= 4) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 4, 5, 10]) if (m * pow >= n) return m * pow;
  return 10 * pow;
}

const shortDate = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fullDate = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

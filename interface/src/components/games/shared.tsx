"use client";

/** UI shared by the full-screen games: finger colours, the draggable hand-twin panel, the end-of-round
 * animation and the small bits the results screens are made of. */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUp, GripHorizontal, Minus, Star } from "lucide-react";
import Spinner from "@/components/Spinner";
import type { Analysis } from "@/lib/engine";
import type { Finger } from "@/lib/handFeatures";

export const FINGER_COLOR: Record<Finger, string> = {
  thumb: "#ffd84a",
  index: "#4aa8ff",
  middle: "#27e0c0",
  ring: "#c79bff",
  pinky: "#ff4f8b",
};

export const PIP_W = 228;
export const OUTRO_MS = 2800;

export const pct = (v: number) => `${Math.round(v * 100)}%`;

export function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="display" style={{ fontSize: "1.6rem", lineHeight: 1.1 }}>{value}</p>
      <p className="field-label" style={{ margin: 0, fontSize: "0.7rem" }}>{label}</p>
    </div>
  );
}


const CONFETTI = ["#ffd84a", "#4aa8ff", "#27e0c0", "#c79bff", "#ff4f8b", "#ff7a3d"];

export function starsFor(stats: { hits: number }, total: number) {
  const acc = total ? stats.hits / total : 0;
  return acc >= 0.9 ? 3 : acc >= 0.6 ? 2 : acc >= 0.3 ? 1 : 0;
}

export function OutroScreen({ stats, total, saving }: { stats: { hits: number }; total: number; saving: boolean }) {
  const stars = starsFor(stats, total);
  return (
    <div className="game-screen">
      <div className="confetti" aria-hidden>
        {Array.from({ length: 36 }, (_, i) => (
          <i
            key={i}
            style={{ ["--x" as string]: `${(i * 37) % 100}%`, ["--c" as string]: CONFETTI[i % CONFETTI.length], ["--d" as string]: `${(i % 9) * 0.12}s` }}
          />
        ))}
      </div>
      <div className="outro-burst">
        <div>
          <p className="display" style={{ fontSize: "2.6rem", textAlign: "center", animation: "title-in 0.7s both" }}>Round done!</p>
          <div className="stars" aria-label={`${stars} of 3 stars`}>
            {[0, 1, 2].map((i) => (
              <Star key={i} className="star" data-on={i < stars} style={{ ["--i" as string]: i }} fill="currentColor" strokeWidth={1.5} />
            ))}
          </div>
        </div>
      </div>
      <p className="muted-on-dark" style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
        {saving && <Spinner size={18} />} {saving ? "Saving your round..." : "Crunching your numbers..."}
      </p>
    </div>
  );
}


export type Tone = "good" | "bad" | "same";

export function Delta({ diff, better, suffix = "" }: { diff: number; better: "up" | "down"; suffix?: string }) {
  const tone: Tone = diff === 0 ? "same" : (diff > 0) === (better === "up") ? "good" : "bad";
  const Icon = diff === 0 ? Minus : diff > 0 ? ArrowUp : ArrowDown;
  return (
    <span className="delta" data-tone={tone}>
      <Icon size={14} strokeWidth={3} />
      {diff === 0 ? "same" : `${Math.abs(diff)}${suffix}`}
    </span>
  );
}

export function fingerStatus(b: number): { text: string; tone: "good" | "same" | "bad"; color: string } {
  if (b < 0.75) return { text: "On target", tone: "good", color: "var(--mint-deep)" };
  if (b < 1.5) return { text: "Slightly off", tone: "same", color: "var(--sun-deep)" };
  return { text: "Needs work", tone: "bad", color: "var(--coral-deep)" };
}

export const TREND_TEXT: Record<Analysis["trend"]["direction"], string> = {
  improving: "Improving",
  declining: "Slipping",
  plateau: "Holding steady",
  building: "Building your baseline",
};


/* ----------------------------------------------------- picture-in-picture */

/** Floating panel over the game; drag it by its handle, it stays inside the viewport. */
export function DraggablePip({ children, hidden }: { children: React.ReactNode; hidden?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const offset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    setPos({ x: parent.clientWidth - PIP_W - 20, y: parent.clientHeight - PIP_W - 60 });
  }, []);

  const clamp = (x: number, y: number) => {
    const parent = ref.current?.parentElement;
    const el = ref.current;
    if (!parent || !el) return { x, y };
    return {
      x: Math.min(Math.max(0, x), parent.clientWidth - el.offsetWidth),
      y: Math.min(Math.max(0, y), parent.clientHeight - el.offsetHeight),
    };
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    offset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const parent = ref.current?.parentElement?.getBoundingClientRect();
    if (!parent) return;
    setPos(clamp(e.clientX - parent.left - offset.current.x, e.clientY - parent.top - offset.current.y));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  return (
    <div
      ref={ref}
      className="pip"
      data-dragging={dragging}
      style={{
        left: pos?.x ?? -9999,
        top: pos?.y ?? -9999,
        visibility: hidden ? "hidden" : "visible",
      }}
    >
      <div className="pip-grip" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <GripHorizontal size={16} /> Your hand twin
      </div>
      {children}
    </div>
  );
}


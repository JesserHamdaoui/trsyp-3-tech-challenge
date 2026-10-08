"use client";

import { useState } from "react";

const BG = "ffd84a,27e0c0,4aa8ff,c79bff,ff4f8b";

/** Funny emoji-face avatar from DiceBear (fun-emoji). The seed is the user's
 * id, so it's stable per person and doesn't leak the email or name to the
 * avatar service. Falls back to initials if the image can't load. */
export default function Avatar({ id, name, size = 40 }: { id: string; name?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initial = (name?.trim()[0] ?? "?").toUpperCase();
  const box = {
    width: size,
    height: size,
    borderRadius: size * 0.32,
    flexShrink: 0,
    background: "var(--sun)",
    boxShadow: "0 3px 0 rgba(2,18,24,0.3)",
    overflow: "hidden",
    display: "grid",
    placeItems: "center",
    color: "var(--deep-950)",
    fontFamily: "var(--font-display)",
    fontSize: size * 0.45,
  } as const;

  if (failed || !id) return <span style={box} aria-hidden="true">{initial}</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://api.dicebear.com/9.x/fun-emoji/svg?seed=${encodeURIComponent(id)}&backgroundColor=${BG}`}
      alt=""
      width={size}
      height={size}
      style={box}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

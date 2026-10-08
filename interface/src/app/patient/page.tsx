"use client";

import { useEffect, useState } from "react";
import { Bird, Lock, Piano } from "lucide-react";
import RoleGate from "@/components/RoleGate";
import { token } from "@/components/care/shared";
import { listMyExercises } from "@/lib/engine";

const GAMES = [
  {
    exerciseId: "piano_isolated_press",
    href: "/patient/piano",
    title: "Piano Press",
    description: "Curl each finger to the target note as it reaches the line. Trains isolated finger control.",
    icon: <Piano size={32} strokeWidth={2.2} />,
  },
  {
    exerciseId: "pinch_flight",
    href: "/patient/pinch",
    title: "Pinch Flight",
    description: "Pinch your thumb to each finger with just the right force to fly a bird through the gates. Trains grip strength and control.",
    icon: <Bird size={32} strokeWidth={2.2} />,
  },
];

export default function PatientPage() {
  const [prescribed, setPrescribed] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    token()
      .then(listMyExercises)
      .then((rows) => setPrescribed(new Set(rows.map((r) => r.exercise_id))))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load your games."));
  }, []);

  const mine = prescribed ? GAMES.filter((g) => prescribed.has(g.exerciseId)) : [];

  return (
    <RoleGate role="patient" title="Your games" subtitle="Pick a game to start a session.">
      {error && <p className="form-error">{error}</p>}
      {!prescribed && !error && (
        <div className="game-grid" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="card" style={{ padding: "1.5rem" }}>
              <div className="skeleton" style={{ width: 64, height: 64 }} />
              <div className="skeleton" style={{ height: 22, width: "50%", marginTop: 18 }} />
              <div className="skeleton" style={{ height: 14, marginTop: 12 }} />
            </div>
          ))}
        </div>
      )}
      {prescribed && mine.length === 0 && (
        <div className="card" style={{ padding: "2rem", textAlign: "center", maxWidth: 520 }}>
          <Lock size={32} strokeWidth={2.4} style={{ color: "var(--foreground-muted)" }} />
          <p className="display" style={{ fontSize: "1.4rem", marginTop: "0.5rem" }}>No games yet</p>
          <p style={{ color: "var(--foreground-muted)", marginTop: "0.4rem" }}>
            Your physiatrist chooses which games you play. Once they prescribe one, it shows up here.
          </p>
        </div>
      )}
      <div className="game-grid">
        {mine.map((game, i) => (
          <a key={game.href} href={game.href} className="card card-link rise" style={{ padding: "1.5rem", ["--i" as string]: i }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: "var(--radius-md)",
                background: "var(--mint)",
                color: "var(--deep-950)",
                boxShadow: "0 5px 0 var(--mint-deep)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: "1.1rem",
              }}
            >
              {game.icon}
            </div>
            <h2 style={{ fontSize: "1.5rem" }}>{game.title}</h2>
            <p style={{ color: "var(--foreground-muted)", marginTop: "0.4rem", fontSize: "0.95rem" }}>{game.description}</p>
            <span className="btn btn-go" style={{ marginTop: "1.25rem", width: "100%" }}>
              Play
            </span>
          </a>
        ))}
      </div>
    </RoleGate>
  );
}

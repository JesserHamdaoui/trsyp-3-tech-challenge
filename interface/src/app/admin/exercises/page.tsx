"use client";

import { useEffect, useState } from "react";
import { Dumbbell, Play } from "lucide-react";
import RoleGate from "@/components/RoleGate";
import { listExercises, type Exercise } from "@/lib/engine";
import { gameForExercise } from "@/lib/games";

export default function AdminExercisesPage() {
  return (
    <RoleGate role="admin" title="Exercises" subtitle="Everything patients can be prescribed. Try any game yourself.">
      <ExerciseCatalog />
    </RoleGate>
  );
}

function ExerciseCatalog() {
  const [exercises, setExercises] = useState<Exercise[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listExercises()
      .then(setExercises)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load exercises."));
  }, []);

  if (error) return <p className="form-error">{error}</p>;
  if (!exercises) {
    return (
      <div className="game-grid">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card" style={{ padding: "1.5rem" }} aria-hidden="true">
            <div className="skeleton" style={{ height: 56, width: 56 }} />
            <div className="skeleton" style={{ height: 20, width: "60%", marginTop: 16 }} />
            <div className="skeleton" style={{ height: 14, width: "85%", marginTop: 10 }} />
          </div>
        ))}
      </div>
    );
  }
  if (exercises.length === 0) {
    return (
      <div className="card" style={{ padding: "1.5rem", color: "var(--foreground-muted)", maxWidth: 480 }}>
        No exercises are registered yet.
      </div>
    );
  }

  return (
    <div className="game-grid">
      {exercises.map((ex, i) => {
        const game = gameForExercise(ex.exercise_id);
        return (
          <div key={ex.id} className="card rise" style={{ padding: "1.5rem", display: "flex", flexDirection: "column", ["--i" as string]: i }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "var(--radius-md)",
                background: "var(--sun)",
                color: "var(--deep-950)",
                boxShadow: "0 4px 0 var(--sun-deep)",
                display: "grid",
                placeItems: "center",
                marginBottom: "1rem",
              }}
            >
              <Dumbbell size={28} strokeWidth={2.4} />
            </div>
            <h2 style={{ fontSize: "1.4rem" }}>{ex.display_name}</h2>
            <p style={{ fontSize: "0.8rem", color: "var(--foreground-muted)", fontFamily: "var(--font-geist-mono, monospace)", marginTop: "0.2rem" }}>
              {ex.exercise_id}
            </p>
            {ex.description && <p style={{ fontSize: "0.92rem", marginTop: "0.6rem" }}>{ex.description}</p>}
            <div style={{ marginTop: "auto", paddingTop: "1.25rem" }}>
              {game ? (
                <a href={game.tryHref} className="btn btn-go" style={{ width: "100%" }}>
                  <Play size={18} fill="currentColor" /> Try {game.title}
                </a>
              ) : (
                <span className="badge" style={{ background: "var(--surface-muted)", color: "var(--foreground-muted)" }}>
                  NO GAME YET
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

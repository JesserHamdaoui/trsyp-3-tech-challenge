"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Plus } from "lucide-react";
import RoleGate from "@/components/RoleGate";
import Avatar from "@/components/Avatar";
import Spinner from "@/components/Spinner";
import { token } from "@/components/care/shared";
import {
  listCarePatients,
  listExercises,
  prescribeExercise,
  removePrescription,
  type CarePatient,
  type Exercise,
} from "@/lib/engine";

export default function PhysiatristPrescriptionsPage() {
  return (
    <RoleGate role="physiatrist" title="Prescriptions" subtitle="Which game each patient plays. Click a cell to prescribe or stop a game.">
      <Matrix />
    </RoleGate>
  );
}

function Matrix() {
  const [patients, setPatients] = useState<CarePatient[] | null>(null);
  const [exercises, setExercises] = useState<Exercise[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPatients(await listCarePatients(await token()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load patients.");
    }
  }, []);

  useEffect(() => {
    load();
    listExercises().then(setExercises).catch((err) => setError(err instanceof Error ? err.message : "Could not load games."));
  }, [load]);

  async function toggle(p: CarePatient, ex: Exercise) {
    const key = `${p.id}:${ex.exercise_id}`;
    setBusy(key);
    setError(null);
    try {
      const t = await token();
      const existing = p.prescription_ids[ex.exercise_id];
      if (existing) await removePrescription(t, existing);
      else await prescribeExercise(t, p.id, ex.exercise_id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the prescription.");
    } finally {
      setBusy(null);
    }
  }

  const loading = !patients || !exercises;

  return (
    <>
      {error && <p className="form-error" style={{ marginBottom: "1rem" }}>{error}</p>}
      <div className="card table-scroll" aria-busy={loading}>
        {loading ? (
          <div style={{ padding: "1.25rem" }}>
            {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 44, marginTop: i ? 10 : 0 }} />)}
          </div>
        ) : patients.length === 0 ? (
          <p style={{ padding: "1.5rem", color: "var(--foreground-muted)" }}>No patients yet. Add one from My patients.</p>
        ) : exercises.length === 0 ? (
          <p style={{ padding: "1.5rem", color: "var(--foreground-muted)" }}>No games in the catalog yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Patient</th>
                {exercises.map((e) => <th key={e.exercise_id} style={{ textAlign: "center" }}>{e.display_name}</th>)}
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/physiatrist/patients/${p.id}`} style={{ display: "flex", gap: "0.7rem", alignItems: "center", color: "inherit", textDecoration: "none" }}>
                      <Avatar id={p.id} name={p.full_name || p.email} size={36} />
                      <span style={{ fontWeight: 800 }}>{p.full_name || p.email}</span>
                    </Link>
                  </td>
                  {exercises.map((e) => {
                    const on = !!p.prescription_ids[e.exercise_id];
                    const key = `${p.id}:${e.exercise_id}`;
                    return (
                      <td key={e.exercise_id} className="rx-cell">
                        <button
                          className="rx-toggle"
                          data-on={on}
                          disabled={busy !== null}
                          onClick={() => toggle(p, e)}
                          aria-pressed={on}
                          aria-label={`${on ? "Stop" : "Prescribe"} ${e.display_name} for ${p.full_name || p.email}`}
                        >
                          {busy === key ? <Spinner /> : on ? <Check size={20} strokeWidth={3.2} /> : <Plus size={18} strokeWidth={3} />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="chart-sub" style={{ marginTop: "0.75rem" }}>
        Stopping a prescription keeps the patient&apos;s past rounds. They just can&apos;t start new ones for that game.
      </p>
    </>
  );
}

"use client";

import { useEffect, useState, FormEvent } from "react";
import { Upload, Video, Piano, Bird } from "lucide-react";
import RoleGate from "@/components/RoleGate";
import ReferenceList from "@/components/ReferenceList";
import FileDropzone from "@/components/FileDropzone";
import RoleSelect from "@/components/RoleSelect";
import { supabase } from "@/lib/supabase";
import { deleteReferences, getAttempt, listExercises, listReferences, submitReferenceAttempt, type Exercise, type ReferenceSummary } from "@/lib/engine";
import Spinner from "@/components/Spinner";
import { Tabs } from "@ark-ui/react/tabs";

export default function AdminReferencePage() {
  return (
    <RoleGate
      role="admin"
      title="Reference attempts"
      subtitle="Record or import idealized performances. Patient attempts are scored against these."
    >
      <ReferenceUpload />
    </RoleGate>
  );
}

/** Games an admin can play to record an idealized attempt. Add an entry per game. */
const RECORDABLE_GAMES = [
  { title: "Piano Press", href: "/admin/reference/piano", icon: <Piano size={26} strokeWidth={2.2} /> },
  { title: "Pinch Flight", href: "/admin/reference/pinch", icon: <Bird size={26} strokeWidth={2.2} /> },
];

/** Accepts a JSON array of frame records, or {frames: [...], meta?: {...}}. */
function parseFrames(text: string): { frames: unknown[]; meta: Record<string, unknown> } {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return { frames: data, meta: {} };
  if (data && Array.isArray(data.frames)) return { frames: data.frames, meta: data.meta ?? {} };
  throw new Error("Expected a JSON array of frames, or an object with a `frames` array.");
}

function ReferenceUpload() {
  const [exercises, setExercises] = useState<Exercise[] | null>(null);
  const [exerciseId, setExerciseId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [references, setReferences] = useState<ReferenceSummary[] | null>(null);
  const [gameTab, setGameTab] = useState("");

  const activeTab = gameTab || exercises?.[0]?.exercise_id || "";

  async function loadReferences() {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) setReferences(await listReferences(token).catch(() => []));
  }

  useEffect(() => {
    loadReferences();
  }, []);

  async function accessToken() {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error("Not logged in.");
    return data.session.access_token;
  }

  async function handleDelete(ids: number[]) {
    try {
      await deleteReferences(await accessToken(), ids);
      setReferences((prev) => prev?.filter((r) => !ids.includes(r.id)) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  /** One id -> one .json file in the same shape the importer accepts; several -> one bundle per id, downloaded in turn. */
  async function handleExport(ids: number[]) {
    try {
      const token = await accessToken();
      for (const id of ids) {
        const a = await getAttempt(token, id);
        const blob = new Blob([JSON.stringify({ frames: a.frames, meta: a.meta }, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `reference_${a.exercise_id}_${a.id}.json`;
        link.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    }
  }

  useEffect(() => {
    listExercises()
      .then((list) => {
        setExercises(list);
        if (list[0]) setExerciseId(list[0].exercise_id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load exercises."));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file || !exerciseId) return;
    setError(null);
    setSuccess(null);
    setUploading(true);
    try {
      const { frames, meta } = parseFrames(await file.text());
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Not logged in.");
      const attempt = await submitReferenceAttempt(token, exerciseId, frames, meta);
      setSuccess(`Reference #${attempt.id} saved for ${attempt.exercise_id} (${frames.length} frames).`);
      setFile(null);
      await loadReferences();
      setFormKey((k) => k + 1); // remounts the dropzone to clear it
    } catch (err) {
      setError(
        err instanceof SyntaxError ? "That file isn't valid JSON." : err instanceof Error ? err.message : "Upload failed."
      );
    } finally {
      setUploading(false);
    }
  }

  return (
  <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
    <div style={{ flex: "1 1 320px", maxWidth: 520, display: "flex", flexDirection: "column", gap: "1.5rem" }}>
    <div className="card" style={{ padding: "1.75rem" }}>
      <p className="display" style={{ fontSize: "1.2rem" }}>
        <Video size={20} strokeWidth={2.6} style={{ verticalAlign: "-3px" }} /> Record in a game
      </p>
      <p style={{ fontSize: "0.9rem", color: "var(--foreground-muted)", margin: "0.35rem 0 1rem" }}>
        Play the game yourself on camera. The round is saved as an idealized reference.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {RECORDABLE_GAMES.map((g) => (
          <a key={g.href} href={g.href} className="btn btn-sun" style={{ justifyContent: "flex-start" }}>
            {g.icon} {g.title}
          </a>
        ))}
      </div>
    </div>

    <div className="card" style={{ padding: "1.75rem" }}>
      <p className="display" style={{ fontSize: "1.2rem", marginBottom: "0.9rem" }}>
        <Upload size={20} strokeWidth={2.6} style={{ verticalAlign: "-3px" }} /> Import a file
      </p>
      {exercises?.length === 0 ? (
        <p style={{ color: "var(--foreground-muted)" }}>
          No exercises in the catalog yet. Register one on the engine first.
        </p>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
          {!exercises && !error && (
            <div aria-busy="true">
              <div className="skeleton" style={{ height: 14, width: 80, marginBottom: 10 }} />
              <div className="skeleton" style={{ height: 48 }} />
            </div>
          )}
          {exercises && (
            <RoleSelect
              label="Exercise"
              value={exerciseId}
              onChange={setExerciseId}
              options={exercises.map((ex) => ({ value: ex.exercise_id, label: ex.display_name }))}
            />
          )}
          <FileDropzone key={formKey} label="Frames file (.json)" accept={{ "application/json": [".json"] }} onFile={setFile} />
          <p style={{ fontSize: "0.85rem", color: "var(--foreground-muted)" }}>
            Per-frame hand records, in the same format games submit. Stored as an idealized attempt with no patient attached.
          </p>
          {error && <p className="form-error">{error}</p>}
          {success && <p className="form-success">{success}</p>}
          <button type="submit" disabled={uploading || !file || !exerciseId} className="btn btn-sun">
            {uploading ? <Spinner /> : <Upload size={18} strokeWidth={3} />} {uploading ? "Uploading..." : "Upload reference"}
          </button>
        </form>
      )}
    </div>
    </div>

    <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <p className="field-label" style={{ margin: 0 }}>Uploaded references</p>
      {!exercises ? (
        <div className="skeleton" style={{ height: 44 }} aria-busy="true" />
      ) : (
        <Tabs.Root value={activeTab} onValueChange={(d) => setGameTab(d.value)} className="tabs">
          <Tabs.List className="tab-list" style={{ overflowX: "auto" }}>
            {exercises.map((ex) => (
              <Tabs.Trigger key={ex.exercise_id} value={ex.exercise_id} className="tab-trigger">
                {ex.display_name}
                <span className="tab-count">{references ? references.filter((r) => r.exercise_id === ex.exercise_id).length : "…"}</span>
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>
      )}
      <ReferenceList
        references={references && exercises ? references.filter((r) => r.exercise_id === activeTab) : null}
        nameFor={(id) => exercises?.find((e) => e.exercise_id === id)?.display_name ?? id}
        onExport={handleExport}
        onDelete={handleDelete}
      />
    </div>
  </div>
  );
}

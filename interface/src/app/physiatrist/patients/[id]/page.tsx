"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Tabs } from "@ark-ui/react/tabs";
import { Dialog } from "@ark-ui/react/dialog";
import { Portal } from "@ark-ui/react/portal";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Minus, Plus, Trash2, X } from "lucide-react";
import RoleGate from "@/components/RoleGate";
import Avatar from "@/components/Avatar";
import Spinner, { BusyLabel } from "@/components/Spinner";
import RoleSelect from "@/components/RoleSelect";
import ChartCard from "@/components/charts/ChartCard";
import LineChart from "@/components/charts/LineChart";
import { SEVERITY_COLOR, Stat, StatusBadge, TrendChip, ago, pct, token } from "@/components/care/shared";
import {
  getAttemptAnalysis,
  getCarePatient,
  listExercises,
  prescribeExercise,
  setPrescriptionHand,
  type Hand,
  removePrescription,
  type Analysis,
  type CareAttempt,
  type CarePatientDetail,
  type Exercise,
} from "@/lib/engine";

export default function PhysiatristPatientPage() {
  return (
    <RoleGate role="physiatrist" title="Patient" subtitle="Progress, finger-level detail, rounds and prescriptions.">
      <Detail />
    </RoleGate>
  );
}

const TABS = [
  { value: "progress", label: "Progress" },
  { value: "fingers", label: "Fingers" },
  { value: "attempts", label: "Rounds" },
  { value: "prescriptions", label: "Prescriptions" },
];

const FINGER_COLOR: Record<string, string> = {
  thumb: "#ffd84a",
  index: "#4aa8ff",
  middle: "#27e0c0",
  ring: "#c79bff",
  pinky: "#ff4f8b",
};

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function Detail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<CarePatientDetail | null>(null);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("progress");
  const [openAttempt, setOpenAttempt] = useState<CareAttempt | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getCarePatient(await token(), id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this patient.");
    }
  }, [id]);

  useEffect(() => {
    load();
    listExercises().then(setExercises).catch(() => {});
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && TABS.some((x) => x.value === t)) setTab(t);
  }, [load]);

  const exName = (eid: string) => exercises.find((e) => e.exercise_id === eid)?.display_name ?? eid;

  return (
    <>
      <Link href="/physiatrist/patients" className="eyebrow muted-on-dark" style={{ fontSize: "0.78rem" }}>
        <ArrowLeft size={14} strokeWidth={3} style={{ verticalAlign: "-2px" }} /> My patients
      </Link>

      {error && <p className="form-error" style={{ marginTop: "1rem" }}>{error}</p>}
      {!data && !error && (
        <div aria-busy="true" style={{ marginTop: "1rem" }}>
          <div className="card" style={{ padding: "1.25rem", display: "flex", gap: "1rem", alignItems: "center" }}>
            <div className="skeleton" style={{ width: 72, height: 72 }} />
            <div style={{ flex: 1 }}>
              <div className="skeleton" style={{ height: 22, width: "35%" }} />
              <div className="skeleton" style={{ height: 14, width: "25%", marginTop: 10 }} />
            </div>
          </div>
          <div className="skeleton" style={{ height: 260, marginTop: "1.25rem" }} />
        </div>
      )}

      {data && (
        <>
          <Header data={data} />
          <Tabs.Root value={tab} onValueChange={(d) => setTab(d.value)} className="tabs" style={{ marginTop: "1.5rem" }}>
            <Tabs.List className="tab-list">
              {TABS.map((t) => (
                <Tabs.Trigger key={t.value} value={t.value} className="tab-trigger">
                  {t.label}
                  {t.value === "attempts" && <span className="tab-count">{data.summary.rounds}</span>}
                  {t.value === "prescriptions" && <span className="tab-count">{data.prescriptions.length}</span>}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            <Tabs.Content value="progress" style={{ marginTop: "1.25rem" }}>
              <Progress data={data} exName={exName} />
            </Tabs.Content>
            <Tabs.Content value="fingers" style={{ marginTop: "1.25rem" }}>
              {data.latest_analysis ? <FingerAnalysis a={data.latest_analysis} /> : <Empty text="No analysed rounds yet." />}
            </Tabs.Content>
            <Tabs.Content value="attempts" style={{ marginTop: "1.25rem" }}>
              <Attempts rows={data.attempts} exName={exName} onOpen={setOpenAttempt} />
            </Tabs.Content>
            <Tabs.Content value="prescriptions" style={{ marginTop: "1.25rem" }}>
              <Prescriptions data={data} exercises={exercises} onChanged={load} />
            </Tabs.Content>
          </Tabs.Root>
        </>
      )}

      <Dialog.Root open={openAttempt !== null} onOpenChange={(d) => !d.open && setOpenAttempt(null)} lazyMount unmountOnExit>
        <Portal>
          <Dialog.Backdrop className="dialog-backdrop" />
          <Dialog.Positioner className="drawer-positioner">
            <Dialog.Content className="drawer">{openAttempt && <AttemptDrawer attempt={openAttempt} exName={exName} />}</Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="card" style={{ padding: "1.5rem", color: "var(--foreground-muted)" }}>{text}</div>;
}

function Header({ data }: { data: CarePatientDetail }) {
  const s = data.summary;
  return (
    <>
      <div className="card" style={{ padding: "1.25rem", display: "flex", gap: "1.25rem", alignItems: "center", flexWrap: "wrap", marginTop: "1rem" }}>
        <Avatar id={s.id} name={s.full_name || s.email} size={72} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <p className="display" style={{ fontSize: "1.8rem" }}>{s.full_name || "Unnamed patient"}</p>
          <p style={{ color: "var(--foreground-muted)", wordBreak: "break-all" }}>{s.email}</p>
          {s.reasons.length > 0 && (
            <div style={{ marginTop: "0.5rem" }}>
              {s.reasons.map((r) => (
                <p key={r.code} style={{ fontSize: "0.9rem", fontWeight: 800, color: SEVERITY_COLOR[r.severity] }}>{r.text}</p>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          <TrendChip trend={s.trend} />
          <StatusBadge status={s.status} />
        </div>
      </div>
      <div className="stat-grid" style={{ marginTop: "1rem" }}>
        <Stat label="Rounds" value={String(s.rounds)} note={`${s.rounds_7d} in the last 7 days`} />
        <Stat label="Last round" value={ago(s.last_round_at)} />
        <Stat label="Recent accuracy" value={pct(s.recent_accuracy)} note="Average of the last 3 rounds" />
        <Stat label="Overall accuracy" value={pct(s.avg_accuracy)} />
        <Stat
          label="Match to ideal"
          value={data.latest_analysis?.deviation_score != null ? `${Math.round(data.latest_analysis.deviation_score)}/100` : "—"}
          note="Latest round vs. idealized recordings"
        />
      </div>
    </>
  );
}

function Progress({ data, exName }: { data: CarePatientDetail; exName: (id: string) => string }) {
  const asc = [...data.attempts].reverse();
  const a = data.latest_analysis;
  const adapt = a?.adaptation;
  return (
    <>
      {asc.length === 0 ? (
        <Empty text="No rounds yet. Charts appear after the first one." />
      ) : (
        <div className="chart-grid">
          <ChartCard
            title="Accuracy per round"
            subtitle="Share of notes hit cleanly, oldest to newest"
            table={{ head: ["Date", "Game", "Accuracy"], rows: asc.map((r) => [dayLabel(r.created_at), exName(r.exercise_id), pct(r.accuracy)]) }}
          >
            <LineChart
              seriesName="Accuracy"
              color="var(--series-3)"
              yMax={1}
              format={(v) => `${Math.round(v * 100)}%`}
              points={asc.map((r) => ({ label: dayLabel(r.created_at), value: r.accuracy }))}
            />
          </ChartCard>
          <ChartCard
            title="Score per round"
            subtitle="Points scored, oldest to newest"
            table={{ head: ["Date", "Score"], rows: asc.map((r) => [dayLabel(r.created_at), r.score ?? "—"]) }}
          >
            <LineChart
              seriesName="Score"
              color="var(--series-1)"
              format={(v) => String(Math.round(v))}
              points={asc.map((r) => ({ label: dayLabel(r.created_at), value: r.score }))}
            />
          </ChartCard>
        </div>
      )}

      {a && (
        <div className="card" style={{ padding: "1.25rem", marginTop: "1.25rem" }}>
          <p className="display" style={{ fontSize: "1.2rem" }}>Where the game is heading</p>
          <p style={{ color: "var(--foreground-muted)", margin: "0.3rem 0 0.8rem" }}>
            Trend over {a.trend.attempts} round{a.trend.attempts === 1 ? "" : "s"}: <b>{a.trend.direction}</b>
            {a.trend.accuracy_level != null && <> · smoothed accuracy <b>{pct(a.trend.accuracy_level)}</b></>}.
          </p>
          {adapt ? <AdaptationList adapt={adapt} /> : <p className="chart-sub">This game doesn&apos;t adapt automatically.</p>}
        </div>
      )}
    </>
  );
}

function AdaptationList({ adapt }: { adapt: NonNullable<Analysis["adaptation"]> }) {
  const tone = adapt.verdict === "hold" ? "same" : adapt.verdict;
  return (
    <>
      <div className="adapt-banner" data-tone={tone}>
        {adapt.verdict === "hold" ? <Minus size={20} strokeWidth={3} /> : adapt.verdict === "harder" ? <ArrowUp size={20} strokeWidth={3} /> : <ArrowDown size={20} strokeWidth={3} />}
        <span>
          Next round: {adapt.verdict === "hold" ? "settings hold steady" : `game gets ${adapt.verdict}`}
        </span>
      </div>
      <p className="setting-hint" style={{ margin: "0.5rem 0" }}>{adapt.rationale} Confidence {Math.round(adapt.confidence * 100)}%.</p>
      {adapt.changes.map((c) => (
        <div key={c.key} className="change-row">
          <span className="delta" data-tone={c.direction === "harder" ? "bad" : "good"} style={{ minWidth: 76, justifyContent: "center" }}>
            {c.direction === "harder" ? <ArrowUp size={14} strokeWidth={3} /> : <ArrowDown size={14} strokeWidth={3} />} {c.direction}
          </span>
          <div style={{ flex: 1 }}>
            <p style={{ fontWeight: 800 }}>{c.label}</p>
            <p style={{ fontSize: "0.8rem", color: "var(--foreground-muted)" }}>{c.reason}</p>
          </div>
          <span className="display" style={{ whiteSpace: "nowrap" }}>
            {String(c.from_value ?? "none")} <ArrowRight size={14} strokeWidth={3} style={{ verticalAlign: "-1px" }} /> {String(c.to_value ?? "none")}
          </span>
        </div>
      ))}
    </>
  );
}

function FingerAnalysis({ a }: { a: Analysis }) {
  return (
    <div className="chart-grid">
      <div className="card chart-card">
        <p className="display" style={{ fontSize: "1.2rem" }}>Finger by finger</p>
        <p className="chart-sub" style={{ marginBottom: "0.8rem" }}>
          Latest round vs. {a.reference.source === "idealized" ? `${a.reference.attempts} idealized recording${a.reference.attempts === 1 ? "" : "s"}` : "built-in targets (no idealized recordings yet)"}. Longer bar = closer to the ideal.
        </p>
        <div style={{ display: "grid", gap: "0.6rem" }}>
          {a.fingers.map((f) => {
            const good = f.badness < 0.75;
            const mid = f.badness < 1.5;
            return (
              <div key={f.finger} className="finger-row">
                <span className="finger-dot" style={{ background: FINGER_COLOR[f.finger] }} />
                <span style={{ fontWeight: 800, textTransform: "capitalize", width: 64 }}>{f.finger}</span>
                <span className="finger-track" aria-hidden>
                  <i style={{ width: `${Math.max(4, 100 - Math.min(100, (f.badness / 3) * 100))}%`, background: good ? "var(--mint-deep)" : mid ? "var(--sun-deep)" : "var(--coral-deep)" }} />
                </span>
                <span className="delta" data-tone={good ? "good" : mid ? "same" : "bad"}>{good ? "On target" : mid ? "Slightly off" : "Needs work"}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card chart-card">
        <p className="display" style={{ fontSize: "1.2rem" }}>What holds them back most</p>
        <p className="chart-sub" style={{ marginBottom: "0.6rem" }}>Biggest deviations from the reference, with their share of the total.</p>
        {a.drivers.length === 0 ? (
          <p style={{ color: "var(--foreground-muted)" }}>Nothing stands out. Their movement matches the reference.</p>
        ) : (
          a.drivers.map((d) => (
            <div key={d.key} className="driver-row">
              <span className="driver-share">{Math.round(d.share * 100)}%</span>
              <span>{d.detail}</span>
            </div>
          ))
        )}
      </div>

      <div className="card chart-card">
        <p className="display" style={{ fontSize: "1.2rem" }}>Per-finger numbers</p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Finger</th><th>Curl depth</th><th>Isolation leak</th><th>Timing</th><th>Clean presses</th></tr>
            </thead>
            <tbody>
              {a.fingers.map((f) => (
                <tr key={f.finger}>
                  <td style={{ textTransform: "capitalize", fontWeight: 800 }}>{f.finger}</td>
                  <td>{f.peak_curl != null ? f.peak_curl.toFixed(2) : "—"}</td>
                  <td>{f.leak != null ? f.leak.toFixed(2) : "—"}</td>
                  <td>{f.latency_ms != null ? `${Math.round(f.latency_ms)} ms` : "—"}</td>
                  <td>{pct(f.clean_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Attempts({ rows, exName, onOpen }: { rows: CareAttempt[]; exName: (id: string) => string; onOpen: (a: CareAttempt) => void }) {
  if (rows.length === 0) return <Empty text="No rounds yet." />;
  return (
    <div className="card table-scroll">
      <table className="data-table">
        <thead>
          <tr><th>When</th><th>Game</th><th>Accuracy</th><th>Score</th><th>Perfect</th><th>Leaky</th><th>Missed</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => onOpen(r)}>
              <td title={new Date(r.created_at).toLocaleString()}>{ago(r.created_at)}</td>
              <td>{exName(r.exercise_id)}</td>
              <td><b>{pct(r.accuracy)}</b></td>
              <td>{r.score ?? "—"}</td>
              <td>{r.hits ?? "—"}</td>
              <td>{r.leaks ?? "—"}</td>
              <td>{r.misses ?? "—"}</td>
              <td><ArrowRight size={16} strokeWidth={2.8} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttemptDrawer({ attempt, exName }: { attempt: CareAttempt; exName: (id: string) => string }) {
  const [a, setA] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getAttemptAnalysis(await token(), attempt.id);
        if (!cancelled) setA(r);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not analyse this round.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt.id]);

  const prev = a?.previous;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <Dialog.Title className="display" style={{ fontSize: "1.6rem" }}>{exName(attempt.exercise_id)}</Dialog.Title>
          <Dialog.Description style={{ color: "var(--foreground-muted)" }}>{new Date(attempt.created_at).toLocaleString()}</Dialog.Description>
        </div>
        <Dialog.CloseTrigger className="icon-btn" aria-label="Close"><X size={20} strokeWidth={2.8} /></Dialog.CloseTrigger>
      </div>

      <h3 className="drawer-h">Result</h3>
      <div className="fact-grid">
        <div className="fact"><span className="field-label" style={{ margin: 0, fontSize: "0.7rem" }}>Accuracy</span><b>{pct(attempt.accuracy)}</b></div>
        <div className="fact"><span className="field-label" style={{ margin: 0, fontSize: "0.7rem" }}>Score</span><b>{attempt.score ?? "—"}</b></div>
        <div className="fact"><span className="field-label" style={{ margin: 0, fontSize: "0.7rem" }}>Perfect / Leaky / Missed</span><b>{attempt.hits ?? "—"} / {attempt.leaks ?? "—"} / {attempt.misses ?? "—"}</b></div>
      </div>

      {error && <p className="form-error" style={{ marginTop: "1rem" }}>{error}</p>}
      {!a && !error && <p className="pending-note" style={{ marginTop: "1rem" }}><Spinner /> Analysing this round...</p>}

      {a && (
        <>
          <h3 className="drawer-h">Versus the ideal</h3>
          <p className="display" style={{ fontSize: "2rem" }}>
            {a.deviation_score != null ? Math.round(a.deviation_score) : "—"}<small style={{ fontSize: "1rem", color: "var(--foreground-muted)" }}>/100</small>
          </p>
          {a.drivers.length === 0 ? (
            <p className="chart-sub">Nothing stands out.</p>
          ) : (
            a.drivers.slice(0, 3).map((d) => (
              <div key={d.key} className="driver-row"><span className="driver-share">{Math.round(d.share * 100)}%</span><span>{d.detail}</span></div>
            ))
          )}

          <h3 className="drawer-h">Versus the previous round</h3>
          {prev ? (
            <>
              <div className="chip-row">
                {prev.accuracy_delta != null && (
                  <span className="delta" data-tone={prev.accuracy_delta > 0 ? "good" : prev.accuracy_delta < 0 ? "bad" : "same"}>
                    Accuracy {prev.accuracy_delta > 0 ? "+" : ""}{Math.round(prev.accuracy_delta * 100)} pts
                  </span>
                )}
                {prev.deviation_delta != null && (
                  <span className="delta" data-tone={prev.deviation_delta > 0 ? "good" : prev.deviation_delta < 0 ? "bad" : "same"}>
                    Match {prev.deviation_delta > 0 ? "+" : ""}{Math.round(prev.deviation_delta)}
                  </span>
                )}
                {prev.improved.map((d) => <span key={d.key} className="delta" data-tone="good"><ArrowUp size={12} strokeWidth={3} />{d.label}</span>)}
                {prev.regressed.map((d) => <span key={d.key} className="delta" data-tone="bad"><ArrowDown size={12} strokeWidth={3} />{d.label}</span>)}
              </div>
            </>
          ) : (
            <p className="chart-sub">First round for this patient.</p>
          )}

          {a.adaptation && (
            <>
              <h3 className="drawer-h">What the game did next</h3>
              <AdaptationList adapt={a.adaptation} />
            </>
          )}
        </>
      )}
    </>
  );
}

/** Who chooses the hand for a game: the patient (asked each round) or the physiatrist (fixed). */
function HandSetting({ rx, disabled, onChanged, onError }: { rx: CarePatientDetail["prescriptions"][number]; disabled: boolean; onChanged: () => Promise<void>; onError: (m: string | null) => void }) {
  const [saving, setSaving] = useState(false);
  const options: { value: Hand | null; label: string }[] = [
    { value: null, label: "Patient picks" },
    { value: "left", label: "Left" },
    { value: "right", label: "Right" },
  ];
  async function choose(h: Hand | null) {
    if (h === rx.hand) return;
    setSaving(true);
    onError(null);
    try {
      await setPrescriptionHand(await token(), rx.id, h);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the hand.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <span className="hand-seg" role="radiogroup" aria-label={`Hand for ${rx.display_name}`}>
      {options.map((o) => (
        <button key={o.label} role="radio" aria-checked={rx.hand === o.value} data-on={rx.hand === o.value} disabled={disabled || saving} onClick={() => choose(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

function Prescriptions({ data, exercises, onChanged }: { data: CarePatientDetail; exercises: Exercise[]; onChanged: () => Promise<void> }) {
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<number | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = exercises.filter((e) => !data.prescriptions.some((p) => p.exercise_id === e.exercise_id));

  useEffect(() => {
    if (!available.some((e) => e.exercise_id === pick)) setPick(available[0]?.exercise_id ?? "");
  }, [available, pick]);

  async function add() {
    if (!pick) return;
    setBusy("add");
    setError(null);
    try {
      await prescribeExercise(await token(), data.summary.id, pick);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not prescribe.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: number) {
    setBusy(id);
    setError(null);
    try {
      await removePrescription(await token(), id);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && <p className="form-error" style={{ marginBottom: "1rem" }}>{error}</p>}
      <div className="card" style={{ overflow: "hidden" }}>
        {data.prescriptions.length === 0 && <p style={{ padding: "1.25rem", color: "var(--foreground-muted)" }}>Nothing prescribed yet. The patient can&apos;t play until you add a game.</p>}
        {data.prescriptions.map((p, i) => (
          <div key={p.id} className="patient-link-row" style={{ borderTop: i ? "2px solid var(--border)" : undefined }}>
            <span style={{ flex: 1, minWidth: 160 }}>
              <span className="display" style={{ fontSize: "1.1rem", display: "block" }}>{p.display_name}</span>
              <span style={{ fontSize: "0.85rem", color: "var(--foreground-muted)" }}>Prescribed {new Date(p.assigned_at).toLocaleDateString()}</span>
            </span>
            <span className="patient-meta">
              <span><b>{p.rounds}</b> rounds</span>
              <span>Last <b>{ago(p.last_round_at)}</b></span>
              <span>Accuracy <b>{pct(p.avg_accuracy)}</b></span>
            </span>
            <HandSetting rx={p} disabled={busy !== null} onChanged={onChanged} onError={setError} />
            <button className="btn btn-outline btn-sm" onClick={() => remove(p.id)} disabled={busy !== null} aria-label={`Remove ${p.display_name}`}>
              <BusyLabel busy={busy === p.id} busyText="Removing..."><Trash2 size={15} strokeWidth={2.8} /> Remove</BusyLabel>
            </button>
          </div>
        ))}
      </div>

      {available.length > 0 && (
        <div className="card" style={{ padding: "1.25rem", marginTop: "1.25rem", display: "flex", gap: "1rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 240px" }}>
            <RoleSelect label="Add a game" value={pick} onChange={setPick} options={available.map((e) => ({ value: e.exercise_id, label: e.display_name }))} />
          </div>
          <button className="btn btn-sun" onClick={add} disabled={busy !== null || !pick}>
            <BusyLabel busy={busy === "add"} busyText="Adding..."><Plus size={18} strokeWidth={3} /> Prescribe</BusyLabel>
          </button>
        </div>
      )}
    </>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Tabs } from "@ark-ui/react/tabs";
import { ArrowRight, Award, CalendarCheck, Flame, Gamepad2, Medal, Star, Trophy } from "lucide-react";
import RoleGate from "@/components/RoleGate";
import ChartCard from "@/components/charts/ChartCard";
import LineChart from "@/components/charts/LineChart";
import SettingMeter from "@/components/games/SettingMeter";
import { token, pct } from "@/components/care/shared";
import {
  getAttemptHistory,
  getNextParams,
  listExercises,
  listMyExercises,
  type Analysis,
  type AttemptHistoryItem,
  type Exercise,
} from "@/lib/engine";
import { GAMES } from "@/lib/games";
import { PARAM_LABELS, normalizeParams, type NumericParamKey } from "@/lib/pianoGame";

export default function PatientProgressPage() {
  return (
    <RoleGate role="patient" title="My progress" subtitle="How you're doing, round by round.">
      <Progress />
    </RoleGate>
  );
}

interface Round {
  id: number;
  at: Date;
  accuracy: number | null;
  score: number | null;
  stars: number;
}

interface GameData {
  exercise: Exercise;
  rounds: Round[]; // oldest first
  analysis: Analysis | null;
}

const FINGER_COLOR: Record<string, string> = {
  thumb: "#ffd84a",
  index: "#4aa8ff",
  middle: "#27e0c0",
  ring: "#c79bff",
  pinky: "#ff4f8b",
};

function toRound(a: AttemptHistoryItem): Round {
  const m = a.meta as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const hits = n(m.hits);
  const total = hits + n(m.leaks) + n(m.misses);
  const accuracy = total ? hits / total : null;
  const p = m.params as { sequenceLength?: number } | undefined;
  const seq = p?.sequenceLength ?? total;
  const hitShare = seq ? hits / seq : 0;
  return {
    id: a.id,
    at: new Date(a.created_at),
    accuracy,
    score: typeof m.score === "number" ? m.score : null,
    stars: hitShare >= 0.9 ? 3 : hitShare >= 0.6 ? 2 : hitShare >= 0.3 ? 1 : 0,
  };
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function streakOf(rounds: Round[]): number {
  const days = new Set(rounds.map((r) => dayKey(r.at)));
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // today may not be played yet
  let n = 0;
  while (days.has(dayKey(d))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function Progress() {
  const [games, setGames] = useState<GameData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await token();
        const [mine, catalog] = await Promise.all([listMyExercises(t), listExercises()]);
        const playable = mine.filter((m) => GAMES.some((g) => g.exerciseId === m.exercise_id));
        const data = await Promise.all(
          playable.map(async (m): Promise<GameData> => {
            const [hist, analysis] = await Promise.all([
              getAttemptHistory(t, m.exercise_id, 50),
              getNextParams(t, m.exercise_id).catch(() => null),
            ]);
            return {
              exercise: catalog.find((e) => e.exercise_id === m.exercise_id) ?? {
                id: 0,
                exercise_id: m.exercise_id,
                display_name: m.exercise_id,
                description: "",
              },
              rounds: hist.map(toRound).reverse(),
              analysis,
            };
          })
        );
        if (cancelled) return;
        setGames(data);
        setTab(data[0]?.exercise.exercise_id ?? "");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load your progress.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="form-error">{error}</p>;
  if (!games) return <Skeleton />;
  if (games.length === 0) {
    return (
      <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
        <p className="display" style={{ fontSize: "1.4rem" }}>No games yet</p>
        <p style={{ color: "var(--foreground-muted)", margin: "0.4rem 0 1rem" }}>
          Your physiatrist hasn&apos;t prescribed a game yet. Once they do, your progress shows up here.
        </p>
        <Link href="/patient" className="btn btn-go"><Gamepad2 size={18} strokeWidth={2.8} /> Go to games</Link>
      </div>
    );
  }

  const body = (g: GameData) => <GameProgress game={g} />;
  if (games.length === 1) return body(games[0]);
  return (
    <Tabs.Root value={tab} onValueChange={(d) => setTab(d.value)} className="tabs">
      <Tabs.List className="tab-list">
        {games.map((g) => (
          <Tabs.Trigger key={g.exercise.exercise_id} value={g.exercise.exercise_id} className="tab-trigger">
            {g.exercise.display_name}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {games.map((g) => (
        <Tabs.Content key={g.exercise.exercise_id} value={g.exercise.exercise_id} style={{ marginTop: "1.25rem" }}>
          {body(g)}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true">
      <div className="stat-grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card stat-tile">
            <div className="skeleton" style={{ height: 12, width: "50%" }} />
            <div className="skeleton" style={{ height: 34, width: "40%", marginTop: 12 }} />
          </div>
        ))}
      </div>
      <div className="skeleton" style={{ height: 260, marginTop: "1.25rem" }} />
    </div>
  );
}

function BigStat({ icon, label, value, note, tone }: { icon: React.ReactNode; label: string; value: string; note?: string; tone: string }) {
  return (
    <div className="card stat-tile" style={{ display: "flex", gap: "0.9rem", alignItems: "center" }}>
      <span className="setting-icon" style={{ ["--c" as string]: tone, width: 52, height: 52, borderRadius: 16 }}>{icon}</span>
      <div>
        <p className="field-label" style={{ margin: 0 }}>{label}</p>
        <p className="stat-value" style={{ lineHeight: 1.1 }}>{value}</p>
        {note && <p className="stat-note">{note}</p>}
      </div>
    </div>
  );
}

function GameProgress({ game }: { game: GameData }) {
  const { rounds, analysis, exercise } = game;
  const stats = useMemo(() => {
    const week = Date.now() - 7 * 86400000;
    const accs = rounds.map((r) => r.accuracy).filter((a): a is number => a != null);
    return {
      total: rounds.length,
      week: rounds.filter((r) => r.at.getTime() >= week).length,
      streak: streakOf(rounds),
      bestScore: rounds.reduce((m, r) => Math.max(m, r.score ?? 0), 0),
      bestAcc: accs.length ? Math.max(...accs) : null,
    };
  }, [rounds]);

  if (rounds.length === 0) {
    return (
      <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
        <p className="display" style={{ fontSize: "1.4rem" }}>Play your first round of {exercise.display_name}</p>
        <p style={{ color: "var(--foreground-muted)", margin: "0.4rem 0 1rem" }}>Your progress starts to fill in after one round.</p>
        <Link href="/patient" className="btn btn-go"><Gamepad2 size={18} strokeWidth={2.8} /> Play now</Link>
      </div>
    );
  }

  const trend = analysis?.trend.direction;
  const trendBanner =
    trend === "improving"
      ? { tone: "easier", text: "You're getting better. Keep it up!" }
      : trend === "declining"
        ? { tone: "harder", text: "Your last few rounds were a bit lower. A short break or an easier pace can help." }
        : trend === "plateau"
          ? { tone: "same", text: "You're steady. Small steps add up." }
          : { tone: "same", text: "A few more rounds and we can show your trend." };

  return (
    <>
      <div className="adapt-banner" data-tone={trendBanner.tone} style={{ marginBottom: "1rem" }}>
        <Star size={22} strokeWidth={3} /> <span>{trendBanner.text}</span>
      </div>

      <div className="stat-grid">
        <BigStat icon={<Flame size={26} strokeWidth={2.6} />} label="Day streak" value={`${stats.streak}`} note={stats.streak ? "Days in a row you played" : "Play today to start one"} tone="var(--brand)" />
        <BigStat icon={<CalendarCheck size={26} strokeWidth={2.6} />} label="This week" value={`${stats.week}`} note={stats.week === 1 ? "round" : "rounds"} tone="var(--sky-deep)" />
        <BigStat icon={<Trophy size={26} strokeWidth={2.6} />} label="Best score" value={`${stats.bestScore}`} note={`${stats.total} round${stats.total === 1 ? "" : "s"} played`} tone="var(--sun-deep)" />
        <BigStat icon={<Medal size={26} strokeWidth={2.6} />} label="Best accuracy" value={pct(stats.bestAcc)} note="Clean presses in a round" tone="var(--mint-deep)" />
      </div>

      <WeekStrip rounds={rounds} />

      <div className="chart-grid" style={{ marginTop: "1.25rem" }}>
        <ChartCard
          title="Your accuracy"
          subtitle="Share of notes you pressed cleanly, round by round"
          table={{
            head: ["Date", "Accuracy", "Score"],
            rows: rounds.map((r) => [r.at.toLocaleDateString(), pct(r.accuracy), r.score ?? "—"]),
          }}
        >
          <LineChart
            seriesName="Accuracy"
            color="var(--series-3)"
            yMax={1}
            format={(v) => `${Math.round(v * 100)}%`}
            points={rounds.map((r) => ({ label: r.at.toLocaleDateString(undefined, { month: "short", day: "numeric" }), value: r.accuracy }))}
          />
        </ChartCard>

        {analysis && analysis.fingers.length > 0 && <Fingers analysis={analysis} />}
      </div>

      <div className="chart-grid" style={{ marginTop: "1.25rem" }}>
        <Badges rounds={rounds} streak={stats.streak} />
        {analysis?.adaptation && <Difficulty analysis={analysis} />}
      </div>

      <h2 className="analytics-h">Recent rounds</h2>
      <div className="card" style={{ overflow: "hidden" }}>
        {[...rounds].reverse().slice(0, 10).map((r, i) => (
          <div key={r.id} className="patient-link-row" style={{ borderTop: i ? "2px solid var(--border)" : undefined }}>
            <span style={{ width: 120, fontWeight: 800 }}>{r.at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
            <span className="stars" style={{ margin: 0 }} aria-label={`${r.stars} of 3 stars`}>
              {[0, 1, 2].map((s) => (
                <Star key={s} className="star" data-on={s < r.stars} style={{ width: 22, height: 22, transform: "none", animation: "none", filter: "none", ["--i" as string]: s }} fill="currentColor" strokeWidth={1.5} />
              ))}
            </span>
            <span className="finger-track" style={{ flex: 1, minWidth: 100 }} aria-hidden>
              <i style={{ width: `${Math.max(3, (r.accuracy ?? 0) * 100)}%`, background: "var(--series-3)" }} />
            </span>
            <b style={{ width: 48, textAlign: "right" }}>{pct(r.accuracy)}</b>
          </div>
        ))}
      </div>
    </>
  );
}

function WeekStrip({ rounds }: { rounds: Round[] }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const played = rounds.filter((r) => dayKey(r.at) === dayKey(d)).length;
    return { d, played };
  });
  return (
    <div className="card" style={{ padding: "1.1rem 1.25rem", marginTop: "1.25rem" }}>
      <p className="field-label" style={{ marginBottom: "0.7rem" }}>Last 7 days</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "0.5rem" }}>
        {days.map(({ d, played }) => (
          <div key={dayKey(d)} style={{ textAlign: "center" }}>
            <div
              aria-label={`${d.toDateString()}: ${played ? `${played} rounds` : "no rounds"}`}
              style={{
                height: 46,
                borderRadius: 14,
                display: "grid",
                placeItems: "center",
                background: played ? "var(--mint)" : "var(--surface-muted)",
                color: played ? "var(--deep-950)" : "var(--foreground-muted)",
                border: "3px solid " + (played ? "var(--mint-deep)" : "var(--border)"),
              }}
            >
              {played ? <Flame size={22} strokeWidth={2.8} /> : <span style={{ fontWeight: 800 }}>–</span>}
            </div>
            <p style={{ fontSize: "0.75rem", fontWeight: 800, color: "var(--foreground-muted)", marginTop: 4 }}>
              {d.toLocaleDateString(undefined, { weekday: "short" })}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Fingers({ analysis }: { analysis: Analysis }) {
  const sorted = [...analysis.fingers].sort((a, b) => a.badness - b.badness);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  return (
    <div className="card chart-card">
      <p className="display" style={{ fontSize: "1.2rem" }}>Your fingers</p>
      <p className="chart-sub" style={{ marginBottom: "0.8rem" }}>From your last round. A longer bar means a better match to the ideal movement.</p>
      <div style={{ display: "grid", gap: "0.6rem" }}>
        {analysis.fingers.map((f) => {
          const state = f.badness < 0.75 ? { text: "Strong", tone: "good", color: "var(--mint-deep)" } : f.badness < 1.5 ? { text: "Getting there", tone: "same", color: "var(--sun-deep)" } : { text: "Practice me", tone: "bad", color: "var(--coral-deep)" };
          return (
            <div key={f.finger} className="finger-row">
              <span className="finger-dot" style={{ background: FINGER_COLOR[f.finger] }} />
              <span style={{ fontWeight: 800, textTransform: "capitalize", width: 64 }}>{f.finger}</span>
              <span className="finger-track" aria-hidden>
                <i style={{ width: `${Math.max(4, 100 - Math.min(100, (f.badness / 3) * 100))}%`, background: state.color }} />
              </span>
              <span className="delta" data-tone={state.tone} style={{ minWidth: 104, justifyContent: "center" }}>{state.text}</span>
            </div>
          );
        })}
      </div>
      {sorted.length > 1 && (
        <p style={{ marginTop: "0.9rem", fontSize: "0.95rem" }}>
          Strongest: <b style={{ textTransform: "capitalize" }}>{best.finger}</b>
          {worst.badness >= 0.75 && <> · Focus on: <b style={{ textTransform: "capitalize" }}>{worst.finger}</b></>}
        </p>
      )}
    </div>
  );
}

const BADGES = [
  { id: "first", label: "First round", hint: "Play one round", icon: Gamepad2, test: (r: Round[]) => r.length >= 1 },
  { id: "five", label: "Getting going", hint: "Play 5 rounds", icon: Award, test: (r: Round[]) => r.length >= 5 },
  { id: "twenty", label: "Regular", hint: "Play 20 rounds", icon: Medal, test: (r: Round[]) => r.length >= 20 },
  { id: "streak3", label: "On a roll", hint: "3 days in a row", icon: Flame, test: (_: Round[], s: number) => s >= 3 },
  { id: "clean", label: "Clean sweep", hint: "A round with 90%+ accuracy", icon: Star, test: (r: Round[]) => r.some((x) => (x.accuracy ?? 0) >= 0.9) },
  { id: "perfect", label: "Perfect", hint: "A round with every note clean", icon: Trophy, test: (r: Round[]) => r.some((x) => x.accuracy === 1) },
];

function Badges({ rounds, streak }: { rounds: Round[]; streak: number }) {
  const earned = BADGES.filter((b) => b.test(rounds, streak)).length;
  return (
    <div className="card chart-card">
      <p className="display" style={{ fontSize: "1.2rem" }}>Badges</p>
      <p className="chart-sub" style={{ marginBottom: "0.8rem" }}>{earned} of {BADGES.length} earned</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "0.7rem" }}>
        {BADGES.map((b) => {
          const on = b.test(rounds, streak);
          return (
            <div
              key={b.id}
              style={{
                textAlign: "center",
                padding: "0.8rem 0.5rem",
                borderRadius: "var(--radius-md)",
                background: on ? "var(--sun-soft)" : "var(--surface-muted)",
                border: "3px solid " + (on ? "var(--sun)" : "var(--border)"),
                opacity: on ? 1 : 0.65,
              }}
            >
              <b.icon size={28} strokeWidth={2.4} style={{ color: on ? "var(--sun-deep)" : "var(--foreground-muted)" }} />
              <p style={{ fontWeight: 800, marginTop: 4 }}>{b.label}</p>
              <p style={{ fontSize: "0.75rem", color: "var(--foreground-muted)" }}>{on ? "Earned!" : b.hint}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Difficulty({ analysis }: { analysis: Analysis }) {
  const next = normalizeParams(analysis.adaptation!.next_params);
  const keys = Object.keys(PARAM_LABELS) as NumericParamKey[];
  return (
    <div className="card chart-card">
      <p className="display" style={{ fontSize: "1.2rem" }}>Your game right now</p>
      <p className="chart-sub" style={{ marginBottom: "0.8rem" }}>The game adjusts to you after every round. This is how your next round is set up.</p>
      <div style={{ display: "grid", gap: "0.8rem" }}>
        {keys.map((k) => (
          <div key={k}>
            <p className="setting-label">{PARAM_LABELS[k].label}</p>
            <SettingMeter k={k} value={next[k]} />
          </div>
        ))}
      </div>
      <Link href="/patient" className="btn btn-go" style={{ marginTop: "1rem" }}>
        Play next round <ArrowRight size={18} strokeWidth={3} />
      </Link>
    </div>
  );
}

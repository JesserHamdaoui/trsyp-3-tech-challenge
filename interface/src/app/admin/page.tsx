"use client";

import { useEffect, useState } from "react";
import { SegmentGroup } from "@ark-ui/react/segment-group";
import RoleGate from "@/components/RoleGate";
import ChartCard from "@/components/charts/ChartCard";
import LineChart from "@/components/charts/LineChart";
import BarList from "@/components/charts/BarList";
import StackedBar from "@/components/charts/StackedBar";
import { supabase } from "@/lib/supabase";
import { getAnalyticsOverview, type AnalyticsOverview } from "@/lib/engine";
import Spinner from "@/components/Spinner";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export default function AdminAnalyticsPage() {
  return (
    <RoleGate role="admin" title="Analytics" subtitle="How patients are doing, and how care teams are using Flexa.">
      <Dashboard />
    </RoleGate>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card stat-tile">
      <p className="field-label" style={{ margin: 0 }}>{label}</p>
      <p className="stat-value">{value}</p>
      {note && <p className="stat-note">{note}</p>}
    </div>
  );
}

function Dashboard() {
  const [days, setDays] = useState("30");
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFetching(true);
    (async () => {
      try {
        const { data: session } = await supabase.auth.getSession();
        const token = session.session?.access_token;
        if (!token) throw new Error("Not logged in.");
        const overview = await getAnalyticsOverview(token, Number(days));
        if (!cancelled) {
          setData(overview);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load analytics.");
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <>
      <div className="range-row">
        <SegmentGroup.Root className="segments" value={days} onValueChange={(d) => d.value && setDays(d.value)}>
          {RANGES.map((r) => (
            <SegmentGroup.Item key={r.value} value={r.value} asChild={false}>
              <SegmentGroup.ItemText>{r.label}</SegmentGroup.ItemText>
              <SegmentGroup.ItemControl />
              <SegmentGroup.ItemHiddenInput />
            </SegmentGroup.Item>
          ))}
        </SegmentGroup.Root>
        {fetching && <Spinner />}
        <span className="chart-sub">Applies to the charts below. Totals are all-time.</span>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!data && !error && <Skeleton />}
      {data && <Charts data={data} refetching={fetching} />}
    </>
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
      <div className="chart-grid">
        {[0, 1].map((i) => (
          <div key={i} className="card chart-card">
            <div className="skeleton" style={{ height: 18, width: "45%" }} />
            <div className="skeleton" style={{ height: 200, marginTop: 16 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Charts({ data, refetching }: { data: AnalyticsOverview; refetching: boolean }) {
  const t = data.totals;
  const o = data.outcomes;
  const scored = o.hits + o.leaks + o.misses;
  const attemptsInRange = data.by_day.reduce((s, d) => s + d.attempts, 0);
  const rxStartedPct = data.adherence_rate;

  return (
    <div className={refetching ? "refetching" : undefined}>
      <div className="stat-grid">
        <Stat label="Patients" value={String(t.patients)} note={`${data.active_patients} active in the last 7 days`} />
        <Stat label="Physiatrists" value={String(t.physiatrists)} note={`${t.assignments} patient assignments`} />
        <Stat label={`Rounds, ${data.days} days`} value={attemptsInRange.toLocaleString()} note={`${t.attempts.toLocaleString()} all-time`} />
        <Stat label="Avg accuracy" value={pct(data.avg_accuracy)} note={`Clean hits over ${scored.toLocaleString()} scored notes`} />
        <Stat
          label="Prescriptions started"
          value={pct(rxStartedPct)}
          note={`${data.prescriptions_started} of ${t.prescriptions} prescribed games played at least once`}
        />
      </div>

      <h2 className="analytics-h">Patient performance</h2>
      <div className="chart-grid">
        <ChartCard
          title="Rounds played per day"
          subtitle={`Patient sessions across all games, last ${data.days} days`}
          table={{ head: ["Date", "Rounds"], rows: data.by_day.map((d) => [d.date, d.attempts]) }}
        >
          <LineChart
            seriesName="Rounds"
            color="var(--series-1)"
            format={(v) => String(Math.round(v))}
            points={data.by_day.map((d) => ({ label: d.date, value: d.attempts }))}
          />
        </ChartCard>

        <ChartCard
          title="Average accuracy per day"
          subtitle="Share of notes hit cleanly. Days with no scored rounds are gaps."
          table={{ head: ["Date", "Accuracy"], rows: data.by_day.map((d) => [d.date, pct(d.avg_accuracy)]) }}
        >
          <LineChart
            seriesName="Accuracy"
            color="var(--series-3)"
            yMax={1}
            format={(v) => `${Math.round(v * 100)}%`}
            points={data.by_day.map((d) => ({ label: d.date, value: d.avg_accuracy }))}
          />
        </ChartCard>

        <ChartCard
          title="Note outcomes"
          subtitle="Every scored note in the range"
          table={{
            head: ["Outcome", "Notes"],
            rows: [["Clean hit", o.hits], ["Leak", o.leaks], ["Miss", o.misses]],
          }}
        >
          <StackedBar
            segments={[
              { label: "Clean hit", value: o.hits, color: "var(--status-good)", icon: "good" },
              { label: "Leak", value: o.leaks, color: "var(--status-warning)", icon: "warning" },
              { label: "Miss", value: o.misses, color: "var(--status-critical)", icon: "critical" },
            ]}
          />
        </ChartCard>

        <ChartCard
          title="Accuracy by exercise"
          subtitle="Average clean-hit rate per game"
          table={{
            head: ["Exercise", "Rounds", "Patients", "Accuracy", "Avg score"],
            rows: data.by_exercise.map((e) => [e.display_name, e.attempts, e.patients_played, pct(e.avg_accuracy), e.avg_score ?? "—"]),
          }}
        >
          <BarList
            color="var(--series-3)"
            max={1}
            items={data.by_exercise
              .filter((e) => e.avg_accuracy != null)
              .map((e) => ({
                label: e.display_name,
                value: e.avg_accuracy!,
                display: pct(e.avg_accuracy),
                detail: [`${e.attempts} rounds`, `${e.patients_played} patients`, e.avg_score != null ? `Avg score ${e.avg_score}` : "No score"],
              }))}
          />
        </ChartCard>
      </div>

      <h2 className="analytics-h">Care team usage</h2>
      <div className="chart-grid">
        <ChartCard
          title="Patient rounds by physiatrist"
          subtitle={`Rounds played by each physiatrist's patients, last ${data.days} days`}
          table={{
            head: ["Physiatrist", "Patients", "Active (7d)", "Prescriptions", "Rounds"],
            rows: data.by_physiatrist.map((p) => [p.name, p.patients, p.active_patients, p.prescriptions, p.patient_attempts]),
          }}
        >
          <BarList
            color="var(--series-1)"
            items={data.by_physiatrist.map((p) => ({
              label: p.name,
              value: p.patient_attempts,
              display: String(p.patient_attempts),
              detail: [`${p.patients} patients`, `${p.active_patients} active this week`, `${p.prescriptions} prescriptions`],
            }))}
          />
        </ChartCard>

        <ChartCard
          title="Prescriptions by physiatrist"
          subtitle="Games prescribed, all-time"
          table={{ head: ["Physiatrist", "Prescriptions"], rows: data.by_physiatrist.map((p) => [p.name, p.prescriptions]) }}
        >
          <BarList
            color="var(--series-2)"
            items={[...data.by_physiatrist]
              .sort((a, b) => b.prescriptions - a.prescriptions)
              .map((p) => ({
                label: p.name,
                value: p.prescriptions,
                display: String(p.prescriptions),
                detail: [`${p.patients} patients`],
              }))}
          />
        </ChartCard>

        <ChartCard
          title="Usage by exercise"
          subtitle={`Rounds played vs. times prescribed`}
          table={{
            head: ["Exercise", "Prescribed", "Rounds"],
            rows: data.by_exercise.map((e) => [e.display_name, e.prescriptions, e.attempts]),
          }}
        >
          <BarList
            color="var(--series-1)"
            items={data.by_exercise.map((e) => ({
              label: e.display_name,
              value: e.attempts,
              display: String(e.attempts),
              detail: [`${e.prescriptions} prescriptions`, `${e.patients_played} patients played`],
            }))}
          />
        </ChartCard>
      </div>
    </div>
  );
}

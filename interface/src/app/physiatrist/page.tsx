"use client";

import { useEffect, useState } from "react";
import { SegmentGroup } from "@ark-ui/react/segment-group";
import Link from "next/link";
import { ArrowRight, TriangleAlert, TrendingUp } from "lucide-react";
import RoleGate from "@/components/RoleGate";
import Avatar from "@/components/Avatar";
import Spinner from "@/components/Spinner";
import ChartCard from "@/components/charts/ChartCard";
import LineChart from "@/components/charts/LineChart";
import StackedBar from "@/components/charts/StackedBar";
import { Stat, StatusBadge, TrendChip, SEVERITY_COLOR, ago, pct, token } from "@/components/care/shared";
import { getCareOverview, type CareOverview } from "@/lib/engine";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

export default function PhysiatristOverviewPage() {
  return (
    <RoleGate role="physiatrist" title="Overview" subtitle="Who needs you today, and how your patients are doing.">
      <Overview />
    </RoleGate>
  );
}

function Overview() {
  const [days, setDays] = useState("30");
  const [data, setData] = useState<CareOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFetching(true);
    (async () => {
      try {
        const o = await getCareOverview(await token(), Number(days));
        if (!cancelled) {
          setData(o);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the overview.");
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
            <SegmentGroup.Item key={r.value} value={r.value}>
              <SegmentGroup.ItemText>{r.label}</SegmentGroup.ItemText>
              <SegmentGroup.ItemControl />
              <SegmentGroup.ItemHiddenInput />
            </SegmentGroup.Item>
          ))}
        </SegmentGroup.Root>
        {fetching && <Spinner />}
        <span className="chart-sub">Applies to the charts. The tiles and attention list are current.</span>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!data && !error && <Skeleton />}
      {data && <Body data={data} refetching={fetching} />}
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
      <div className="card" style={{ padding: "1.25rem", marginTop: "1.25rem" }}>
        <div className="skeleton" style={{ height: 120 }} />
      </div>
    </div>
  );
}

function Body({ data, refetching }: { data: CareOverview; refetching: boolean }) {
  const o = data.outcomes;
  return (
    <div className={refetching ? "refetching" : undefined}>
      <div className="stat-grid">
        <Stat label="My patients" value={String(data.patients)} note={`${data.active_patients} played in the last 7 days`} />
        <Stat label="Needs attention" value={String(data.needs_attention)} note={data.needs_attention ? "See the list below" : "Everyone is on track"} />
        <Stat label="Avg accuracy" value={pct(data.avg_accuracy)} note={`Over the last ${data.days} days`} />
        <Stat label="Prescriptions started" value={pct(data.adherence_rate)} note="Prescribed games played at least once" />
        <Stat label={`Rounds, ${data.days} days`} value={data.rounds.toLocaleString()} />
      </div>

      <h2 className="analytics-h"><TriangleAlert size={20} strokeWidth={2.8} style={{ verticalAlign: "-3px" }} /> Needs attention</h2>
      <div className="card" style={{ overflow: "hidden" }}>
        {data.attention.length === 0 ? (
          <p style={{ padding: "1.25rem", color: "var(--foreground-muted)" }}>
            {data.patients === 0 ? "No patients yet. Add one from My patients." : "Nobody needs attention right now."}
          </p>
        ) : (
          data.attention.map((p, i) => (
            <Link
              key={p.id}
              href={`/physiatrist/patients/${p.id}`}
              className="patient-row attention-row"
              style={{ borderTop: i ? "2px solid var(--border)" : undefined }}
            >
              <Avatar id={p.id} name={p.full_name || p.email} size={44} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="display" style={{ fontSize: "1.1rem", display: "block" }}>{p.full_name || p.email}</span>
                {p.reasons.slice(0, 3).map((r) => (
                  <span key={r.code} style={{ display: "block", fontSize: "0.88rem", color: SEVERITY_COLOR[r.severity], fontWeight: 700 }}>
                    {r.text}
                  </span>
                ))}
              </span>
              <span className="patient-meta">
                <span>Last round <b>{ago(p.last_round_at)}</b></span>
                <span>Recent <b>{pct(p.recent_accuracy)}</b></span>
              </span>
              <TrendChip trend={p.trend} />
              <StatusBadge status={p.status} />
              <ArrowRight size={18} strokeWidth={2.8} />
            </Link>
          ))
        )}
      </div>

      <h2 className="analytics-h">Patient performance</h2>
      <div className="chart-grid">
        <ChartCard
          title="Rounds per day"
          subtitle={`All of your patients, last ${data.days} days`}
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
          table={{ head: ["Outcome", "Notes"], rows: [["Clean hit", o.hits], ["Leak", o.leaks], ["Miss", o.misses]] }}
        >
          <StackedBar
            segments={[
              { label: "Clean hit", value: o.hits, color: "var(--status-good)", icon: "good" },
              { label: "Leak", value: o.leaks, color: "var(--status-warning)", icon: "warning" },
              { label: "Miss", value: o.misses, color: "var(--status-critical)", icon: "critical" },
            ]}
          />
        </ChartCard>

        <div className="card chart-card">
          <p className="display" style={{ fontSize: "1.2rem" }}><TrendingUp size={20} strokeWidth={2.6} style={{ verticalAlign: "-3px" }} /> Most improved</p>
          <p className="chart-sub" style={{ marginBottom: "0.75rem" }}>First half of their rounds vs. the second half.</p>
          {data.movers.length === 0 ? (
            <p style={{ color: "var(--foreground-muted)" }}>Not enough rounds yet to see movement.</p>
          ) : (
            data.movers.map((m) => (
              <Link key={m.id} href={`/physiatrist/patients/${m.id}`} className="driver-row" style={{ alignItems: "center" }}>
                <Avatar id={m.id} name={m.name} size={32} />
                <span style={{ flex: 1, fontWeight: 800 }}>{m.name}</span>
                <span className="delta" data-tone="good">{pct(m.from_accuracy)} → {pct(m.to_accuracy)}</span>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

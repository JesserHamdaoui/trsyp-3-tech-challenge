"use client";

import { ReactNode, useState } from "react";
import { BarChart3, Table2 } from "lucide-react";

export interface TableView {
  head: string[];
  rows: (string | number)[][];
}

/** Card with title, optional table view of the same data, and a chart body. */
export default function ChartCard({
  title,
  subtitle,
  table,
  children,
}: {
  title: string;
  subtitle?: string;
  table: TableView;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card chart-card">
      <header style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem" }}>{title}</h2>
          {subtitle && <p className="chart-sub">{subtitle}</p>}
        </div>
        <button type="button" className="icon-btn" onClick={() => setAsTable((v) => !v)} aria-label={asTable ? "Show chart" : "Show as table"} title={asTable ? "Show chart" : "Show as table"}>
          {asTable ? <BarChart3 size={18} strokeWidth={2.6} /> : <Table2 size={18} strokeWidth={2.6} />}
        </button>
      </header>
      {asTable ? (
        <div className="chart-table-wrap">
          <table className="chart-table">
            <thead>
              <tr>{table.head.map((h) => <th key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </section>
  );
}

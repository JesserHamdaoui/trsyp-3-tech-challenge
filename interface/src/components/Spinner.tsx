/** Inline loading ring. Inherits the current text color, so it works on any button. */
export default function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

/** Spinner + label for a busy button: <BusyLabel busy={saving} busyText="Saving...">Save</BusyLabel> */
export function BusyLabel({ busy, busyText, children }: { busy: boolean; busyText: string; children: React.ReactNode }) {
  return busy ? (
    <>
      <Spinner /> {busyText}
    </>
  ) : (
    <>{children}</>
  );
}

/** Centered full-area loader for session / route checks. */
export function PageLoader({ label, onDark = true }: { label?: string; onDark?: boolean }) {
  return (
    <main className="page" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.9rem", paddingTop: "5rem" }}>
      <Spinner size={36} />
      {label && <p className={onDark ? "muted-on-dark" : undefined} style={{ fontWeight: 800 }}>{label}</p>}
    </main>
  );
}

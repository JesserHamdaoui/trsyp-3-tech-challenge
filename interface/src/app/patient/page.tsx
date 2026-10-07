import AuthForm from "@/components/AuthForm";

const ASSIGNED_GAMES = [
  {
    href: "/patient/piano",
    title: "Piano Press",
    description: "Curl each finger to the target note as it reaches the line. Trains isolated finger control.",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M7 4v10M11 4v10M15 4v10M19 4v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
];

export default function PatientPage() {
  return (
    <main className="page-narrow" style={{ maxWidth: 560 }}>
      <div style={{ marginBottom: "2rem" }}>
        <p style={{ color: "var(--accent-patient)", fontWeight: 700, fontSize: "0.85rem", letterSpacing: "0.02em" }}>
          PATIENT
        </p>
        <h1 style={{ fontSize: "1.75rem", fontWeight: 700, marginTop: "0.25rem" }}>Welcome back</h1>
      </div>

      <AuthForm role="patient">
        {(
          <div>
            <p
              style={{
                fontSize: "0.8rem",
                fontWeight: 700,
                color: "var(--foreground-muted)",
                letterSpacing: "0.02em",
                marginBottom: "0.75rem",
              }}
            >
              YOUR ASSIGNED GAMES
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {ASSIGNED_GAMES.map((game) => (
                <a
                  key={game.href}
                  href={game.href}
                  className="card card-link"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.9rem",
                    padding: "1rem",
                  }}
                >
                  <div
                    style={{
                      width: 42,
                      height: 42,
                      flexShrink: 0,
                      borderRadius: "var(--radius-sm)",
                      background: "var(--accent-patient-soft)",
                      color: "var(--accent-patient)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {game.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: 700, fontSize: "0.95rem" }}>{game.title}</p>
                    <p style={{ fontSize: "0.8rem", color: "var(--foreground-muted)", marginTop: "0.15rem" }}>
                      {game.description}
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                    <path
                      d="M5 12h14M13 6l6 6-6 6"
                      stroke="var(--foreground-muted)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
              ))}
            </div>
          </div>
        )}
      </AuthForm>
    </main>
  );
}

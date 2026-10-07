import Link from "next/link";

const ROLES = [
  {
    href: "/patient",
    title: "Patient",
    description: "Play your assigned rehab exercises and track your progress.",
    accent: "var(--accent-patient)",
    accentSoft: "var(--accent-patient-soft)",
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 21s-7-4.35-9.5-8.5C.7 9.1 2.2 5.5 5.7 5c2-.3 3.6.7 4.3 2.1.7-1.4 2.3-2.4 4.3-2.1 3.5.5 5 4.1 3.2 7.5C19 16.65 12 21 12 21z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    href: "/physiatrist",
    title: "Physiatrist",
    description: "Review patient attempts and compare against idealized form.",
    accent: "var(--accent-physiatrist)",
    accentSoft: "var(--accent-physiatrist-soft)",
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 19V9a2 2 0 0 1 2-2h2V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2h2a2 2 0 0 1 2 2v10"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M4 19h16M9 12h6M12 9v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: "/admin",
    title: "Admin",
    description: "Manage exercises, idealized references, and system data.",
    accent: "var(--accent-admin)",
    accentSoft: "var(--accent-admin-soft)",
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V19a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 13a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 7a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 2.68a1.65 1.65 0 0 0 1-1.51V1a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 7a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

export default function Home() {
  return (
    <main className="page" style={{ maxWidth: 960 }}>
      <div style={{ textAlign: "center", marginBottom: "3rem" }}>
        <h1 style={{ fontSize: "2.2rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Rehab Engine</h1>
        <p style={{ color: "var(--foreground-muted)", fontSize: "1.05rem", marginTop: "0.5rem" }}>
          Pick your role to continue
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "1.25rem",
        }}
      >
        {ROLES.map((role) => (
          <Link
            key={role.href}
            href={role.href}
            className="card card-link"
            style={{ display: "block", padding: "1.75rem" }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: "var(--radius-md)",
                background: role.accentSoft,
                color: role.accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: "1.1rem",
              }}
            >
              {role.icon}
            </div>
            <h2 style={{ fontSize: "1.15rem", fontWeight: 700, marginBottom: "0.4rem" }}>{role.title}</h2>
            <p style={{ color: "var(--foreground-muted)", fontSize: "0.9rem", lineHeight: 1.5 }}>
              {role.description}
            </p>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.3rem",
                marginTop: "1.1rem",
                fontSize: "0.85rem",
                fontWeight: 600,
                color: role.accent,
              }}
            >
              Continue
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </Link>
        ))}
      </div>
    </main>
  );
}

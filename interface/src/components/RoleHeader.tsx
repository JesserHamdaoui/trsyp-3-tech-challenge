import type { Role } from "@/lib/useSession";

const ROLE_STYLE: Record<Role, { label: string; color: string; greeting: string }> = {
  patient: { label: "Patient", color: "var(--accent-patient)", greeting: "Ready to play?" },
  physiatrist: { label: "Physiatrist", color: "var(--accent-physiatrist)", greeting: "Your squad awaits" },
  admin: { label: "Admin", color: "var(--accent-admin)", greeting: "Run the show" },
};

export default function RoleHeader({ role }: { role: Role }) {
  const s = ROLE_STYLE[role];
  return (
    <div className="rise" style={{ marginBottom: "1.5rem" }}>
      <span className="badge" style={{ background: s.color, color: "var(--deep-950)" }}>
        {s.label.toUpperCase()}
      </span>
      <h1 style={{ fontSize: "2.4rem", marginTop: "0.6rem" }}>{s.greeting}</h1>
    </div>
  );
}

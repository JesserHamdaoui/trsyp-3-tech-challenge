import GuestGuard from "@/components/GuestGuard";
import { HeartPulse, Stethoscope, ShieldCheck } from "lucide-react";
import Link from "next/link";

const ROLES = [
  {
    href: "/patient",
    title: "Patient",
    description: "Play the games your physiatrist prescribes and rack up stars.",
    accent: "var(--accent-patient)",
    accentDeep: "var(--accent-patient-deep)",
    tagline: "Play. Heal. Level up.",
    icon: <HeartPulse size={28} strokeWidth={2.2} />,
  },
  {
    href: "/physiatrist",
    title: "Physiatrist",
    description: "Invite patients, prescribe games, review every round.",
    accent: "var(--accent-physiatrist)",
    accentDeep: "var(--accent-physiatrist-deep)",
    tagline: "Guide every recovery.",
    icon: <Stethoscope size={28} strokeWidth={2.2} />,
  },
  {
    href: "/admin",
    title: "Admin",
    description: "Invite your team and set the gold-standard reference.",
    accent: "var(--accent-admin)",
    accentDeep: "var(--accent-admin-deep)",
    tagline: "Run the game.",
    icon: <ShieldCheck size={28} strokeWidth={2.2} />,
  },
];

export default function Home() {
  return (
    <GuestGuard>
    <main className="page" style={{ maxWidth: 1000, position: "relative" }}>
      <div className="confetti float" style={{ width: 26, height: 26, background: "var(--sun)", top: 30, left: "6%", ["--r" as string]: "20deg" }} />
      <div className="confetti float" style={{ width: 18, height: 18, background: "var(--coral)", top: 120, right: "8%", borderRadius: 999, animationDelay: "-1s" }} />
      <div className="confetti float" style={{ width: 22, height: 22, background: "var(--mint)", top: 260, left: "3%", animationDelay: "-2s", ["--r" as string]: "-25deg" }} />

      <div style={{ textAlign: "center", margin: "2.5rem 0 3rem" }} className="rise">
        <span className="badge" style={{ background: "var(--sun)", color: "var(--deep-950)" }}>
          NEW ROUND
        </span>
        <h1 style={{ fontSize: "clamp(2.6rem, 7vw, 4.4rem)", marginTop: "1rem" }}>
          Rehab, <span style={{ color: "var(--sun)" }}>leveled up.</span>
        </h1>
        <p className="muted-on-dark" style={{ fontSize: "1.2rem", marginTop: "0.9rem", maxWidth: 560, marginInline: "auto" }}>
          Flexa turns hand therapy into a playlist of camera-tracked games. Complete exercises, earn stars, and let your care team see every round.
        </p>
        <p className="eyebrow" style={{ marginTop: "2.25rem", color: "var(--on-dark)" }}>
          Pick your role
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          gap: "1.5rem",
        }}
      >
        {ROLES.map((role, i) => (
          <Link
            key={role.href}
            href={role.href}
            className="card card-link rise"
            style={{
              padding: "1.75rem",
              borderTop: `10px solid ${role.accent}`,
              ["--i" as string]: i + 2,
            }}
          >
            <div
              style={{
                width: 60,
                height: 60,
                borderRadius: "var(--radius-md)",
                background: role.accent,
                color: "var(--deep-950)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: "1.1rem",
                boxShadow: `0 5px 0 ${role.accentDeep}`,
              }}
            >
              {role.icon}
            </div>
            <h2 style={{ fontSize: "1.7rem" }}>{role.title}</h2>
            <p className="eyebrow" style={{ color: role.accentDeep, marginTop: "0.25rem", fontSize: "0.78rem" }}>
              {role.tagline}
            </p>
            <p style={{ color: "var(--foreground-muted)", fontSize: "0.95rem", marginTop: "0.7rem" }}>
              {role.description}
            </p>
            <span
              className="btn"
              style={{
                ["--btn-bg" as string]: role.accent,
                ["--btn-edge" as string]: role.accentDeep,
                ["--btn-fg" as string]: "var(--deep-950)",
                marginTop: "1.25rem",
                width: "100%",
              }}
            >
              Join as {role.title.toLowerCase()}
            </span>
          </Link>
        ))}
      </div>
    </main>
    </GuestGuard>
  );
}

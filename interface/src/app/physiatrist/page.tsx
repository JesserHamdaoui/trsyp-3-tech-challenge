import AuthForm from "@/components/AuthForm";

export default function PhysiatristPage() {
  return (
    <main className="page-narrow">
      <div style={{ marginBottom: "2rem" }}>
        <p
          style={{
            color: "var(--accent-physiatrist)",
            fontWeight: 700,
            fontSize: "0.85rem",
            letterSpacing: "0.02em",
          }}
        >
          PHYSIATRIST
        </p>
        <h1 style={{ fontSize: "1.75rem", fontWeight: 700, marginTop: "0.25rem" }}>Welcome back</h1>
      </div>
      <AuthForm role="physiatrist" />
    </main>
  );
}

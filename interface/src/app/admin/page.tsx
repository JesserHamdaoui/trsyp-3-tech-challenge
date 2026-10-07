import AuthForm from "@/components/AuthForm";

export default function AdminPage() {
  return (
    <main className="page-narrow">
      <div style={{ marginBottom: "2rem" }}>
        <p style={{ color: "var(--accent-admin)", fontWeight: 700, fontSize: "0.85rem", letterSpacing: "0.02em" }}>
          ADMIN
        </p>
        <h1 style={{ fontSize: "1.75rem", fontWeight: 700, marginTop: "0.25rem" }}>Welcome back</h1>
      </div>
      <AuthForm role="admin" />
    </main>
  );
}

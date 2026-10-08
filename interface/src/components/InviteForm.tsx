"use client";

import { useState, FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { inviteUser } from "@/lib/engine";
import { Role } from "@/lib/useSession";
import RoleSelect from "@/components/RoleSelect";
import { BusyLabel } from "@/components/Spinner";

export default function InviteForm({
  roleOptions,
  heading,
}: {
  /** roles the current user is allowed to invite; a single entry renders
   * as fixed text, more than one renders a picker */
  roleOptions: { value: Role; label: string }[];
  heading: string;
}) {
  const [role, setRole] = useState<Role>(roleOptions[0].value);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) throw new Error("Not logged in.");

      await inviteUser(accessToken, email, role, fullName);
      setSuccess(`Invite sent to ${email}.`);
      setEmail("");
      setFullName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send invite.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <p className="display" style={{ fontSize: "1.2rem", marginBottom: "0.9rem" }}>
        {heading}
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {roleOptions.length > 1 && (
          <RoleSelect label="Role" options={roleOptions} value={role} onChange={setRole} />
        )}
        <div className="field">
          <label htmlFor="invite-name">Full name</label>
          <input id="invite-name" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="invite-email">Email</label>
          <input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        {error && <p className="form-error">{error}</p>}
        {success && <p className="form-success">{success}</p>}
        <button type="submit" disabled={loading} className="btn btn-sun">
          <BusyLabel busy={loading} busyText="Sending...">Send invite</BusyLabel>
        </button>
      </form>
    </div>
  );
}

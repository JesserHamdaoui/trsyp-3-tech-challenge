"use client";

import AuthGuard from "@/components/AuthGuard";
import PianoGame from "@/components/games/PianoGame";

export default function AdminRecordPianoPage() {
  return (
    <AuthGuard role="admin">
      <PianoGame mode="reference" backHref="/admin/reference" />
    </AuthGuard>
  );
}

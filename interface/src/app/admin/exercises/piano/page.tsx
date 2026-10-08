"use client";

import AuthGuard from "@/components/AuthGuard";
import PianoGame from "@/components/games/PianoGame";

export default function AdminTryPianoPage() {
  return (
    <AuthGuard role="admin">
      <PianoGame mode="practice" backHref="/admin/exercises" />
    </AuthGuard>
  );
}

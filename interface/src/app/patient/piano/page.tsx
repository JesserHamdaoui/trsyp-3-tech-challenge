"use client";

import AuthGuard from "@/components/AuthGuard";
import PianoGame from "@/components/games/PianoGame";

export default function PatientPianoPage() {
  return (
    <AuthGuard role="patient">
      <PianoGame mode="patient" />
    </AuthGuard>
  );
}

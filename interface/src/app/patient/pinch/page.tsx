"use client";

import AuthGuard from "@/components/AuthGuard";
import PinchGame from "@/components/games/PinchGame";

export default function PatientPinchPage() {
  return (
    <AuthGuard role="patient">
      <PinchGame mode="patient" />
    </AuthGuard>
  );
}

"use client";

import AuthGuard from "@/components/AuthGuard";
import PinchGame from "@/components/games/PinchGame";

export default function AdminTryPinchPage() {
  return (
    <AuthGuard role="admin">
      <PinchGame mode="practice" backHref="/admin/exercises" />
    </AuthGuard>
  );
}

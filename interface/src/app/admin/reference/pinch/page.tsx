"use client";

import AuthGuard from "@/components/AuthGuard";
import PinchGame from "@/components/games/PinchGame";

export default function AdminRecordPinchPage() {
  return (
    <AuthGuard role="admin">
      <PinchGame mode="reference" backHref="/admin/reference" />
    </AuthGuard>
  );
}

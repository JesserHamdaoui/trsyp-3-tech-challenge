"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/useSession";
import BrandMark from "./BrandMark";

const ROLE_PATHS = ["/patient", "/physiatrist", "/admin"];

export default function BrandBar() {
  const pathname = usePathname();
  const { user, loading } = useSession();

  // signed-in role pages render their own sidebar with the brand in it
  const roleRoot = ROLE_PATHS.find((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (roleRoot && (loading || user?.role === roleRoot.slice(1))) return null;

  return (
    <header className="topbar">
      <Link href="/" className="brand" aria-label="Flexa home">
        <span className="brand-mark">
          <BrandMark />
        </span>
        Flexa
      </Link>
      <span className="brand-tag">REHAB, LEVELED UP</span>
    </header>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { UserProfile } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Wrench, LogOut, Car, ClipboardList, PlusCircle } from "lucide-react";

interface NavbarProps {
  profile: UserProfile | null;
}

export function Navbar({ profile }: NavbarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = React.useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push("/auth");
      router.refresh();
    } catch (err) {
      console.error("Sign out error:", err);
      setIsSigningOut(false);
    }
  }

  const isCustomer = profile?.role === "customer";
  const isMechanic = profile?.role === "mechanic";

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-gray-200 no-print print:hidden">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center gap-6">
          <Link
            href={isMechanic ? "/mechanic/queue" : "/dashboard"}
            className="flex items-center gap-2 font-bold text-gray-900 tracking-tight text-base"
          >
            <div className="w-8 h-8 rounded-lg bg-[#2563eb] text-white flex items-center justify-center">
              <Wrench className="w-4 h-4" />
            </div>
            <span>ServiceTrack</span>
          </Link>

          {/* Navigation links */}
          {profile && (
            <nav className="hidden sm:flex items-center gap-1">
              {isCustomer && (
                <>
                  <Link
                    href="/dashboard"
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      pathname === "/dashboard"
                        ? "bg-gray-100 text-gray-900"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    Dashboard
                  </Link>
                  <Link
                    href="/book"
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      pathname === "/book"
                        ? "bg-gray-100 text-gray-900"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    Book service
                  </Link>
                </>
              )}

              {isMechanic && (
                <Link
                  href="/mechanic/queue"
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    pathname.startsWith("/mechanic/queue")
                      ? "bg-gray-100 text-gray-900"
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  Inspection Queue
                </Link>
              )}
            </nav>
          )}
        </div>

        {/* Right side: role chip, user identity, sign out */}
        <div className="flex items-center gap-3">
          {profile && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={isMechanic ? "active" : "default"}>
                  {isMechanic ? "Mechanic" : "Customer"}
                </Badge>
                <span className="hidden md:inline-block text-xs text-gray-600 max-w-[150px] truncate">
                  {profile.name || profile.email}
                </span>
              </div>

              <Button
                variant="ghost"
                size="sm"
                isLoading={isSigningOut}
                onClick={handleSignOut}
                className="text-xs text-gray-600 hover:text-gray-900 gap-1 px-2.5"
                title="Sign out of ServiceTrack"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/auth";
import { Navbar } from "@/components/navbar";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await getAuthenticatedUser();

  if (!user || !profile) {
    redirect("/auth");
  }

  return (
    <div className="min-h-screen bg-[#fafafa] text-gray-900 flex flex-col">
      <Navbar profile={profile} />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 md:py-8">
        {children}
      </main>
    </div>
  );
}

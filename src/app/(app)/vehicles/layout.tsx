import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function VehiclesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await getAuthenticatedUser();

  if (!user) {
    redirect("/auth");
  }

  if (profile?.role === "mechanic") {
    redirect("/mechanic/queue");
  }

  return <>{children}</>;
}

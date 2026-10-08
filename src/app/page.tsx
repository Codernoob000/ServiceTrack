import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { user, profile } = await getAuthenticatedUser();

  if (!user || !profile) {
    redirect("/auth");
  }

  if (profile.role === "mechanic") {
    redirect("/mechanic/queue");
  }

  redirect("/dashboard");
}

import { createClient } from "./supabase/server";
import { getServiceRoleClient } from "./supabase/admin";
import { UserProfile } from "./types";
import { User } from "@supabase/supabase-js";

export interface AuthContext {
  user: User | null;
  profile: UserProfile | null;
  error: string | null;
}

/**
 * Validates the current session using supabase.auth.getUser().
 * Reads role and profile strictly from public.users (the authorization source of truth).
 */
export async function getAuthenticatedUser(): Promise<AuthContext> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return { user: null, profile: null, error: "Unauthorized" };
    }

    // Source of truth: public.users table
    const admin = getServiceRoleClient();
    const { data: profile, error: profileError } = await admin
      .from("users")
      .select("id, name, email, phone, role, created_at")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      // In case public.users trigger was delayed or user is missing, default strictly to customer
      const fallbackProfile: UserProfile = {
        id: user.id,
        name: (user.user_metadata?.name as string) || "",
        email: user.email || "",
        phone: (user.user_metadata?.phone as string) || null,
        role: "customer",
        created_at: user.created_at,
      };
      return { user, profile: fallbackProfile, error: null };
    }

    return { user, profile: profile as UserProfile, error: null };
  } catch (err) {
    console.error("Auth check failed:", err);
    return { user: null, profile: null, error: "Internal authentication error" };
  }
}

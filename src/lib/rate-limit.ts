import { getServiceRoleClient } from "./supabase/admin";

/**
 * Serverless rate limiter backed by Supabase PostgreSQL (public.rate_limits table).
 * Works across distributed serverless instances (Vercel) without depending on Node in-memory state.
 *
 * NOTE: Direct calls to Supabase Auth client (e.g. auth.signUp) bypass this API route;
 * ensure rate limiting is also configured in the Supabase Dashboard under Auth Settings.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number = 5,
  windowSeconds: number = 60
): Promise<{ allowed: boolean; error?: string }> {
  try {
    const supabase = getServiceRoleClient();
    const { data, error } = await supabase.rpc("check_rate_limit", {
      p_key: key,
      p_max_requests: maxRequests,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      // In development or if table/function is not yet initialized, fail open with a warning
      console.warn("Rate limit RPC warning:", error.message);
      return { allowed: true };
    }

    return { allowed: !!data };
  } catch (err) {
    console.warn("Rate limiting failed, allowing request:", err);
    return { allowed: true };
  }
}

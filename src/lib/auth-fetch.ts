import { createClient } from "@/lib/supabase/client";

let refreshPromise: Promise<boolean> | null = null;

async function refreshSessionOnce(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase.auth.refreshSession();
        return !error && !!data?.session;
      } catch (err) {
        console.error("Session refresh exception:", err);
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

/**
 * Client-side fetch wrapper that intercepts 401 responses,
 * attempts one session refresh via Supabase browser client,
 * and retries the request once before returning the response.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  let response = await fetch(input, init);

  if (response.status === 401) {
    const refreshed = await refreshSessionOnce();
    if (refreshed) {
      // Retry once after successful session refresh
      response = await fetch(input, init);
    }
  }

  return response;
}

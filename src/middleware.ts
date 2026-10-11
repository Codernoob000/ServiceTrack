import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Safeguard: Never run middleware logic on API, static asset requests, or public history pages
  if (path.startsWith("/api/") || path.startsWith("/_next/") || path.startsWith("/h/")) {
    return NextResponse.next();
  }

  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Both request and response cookies must be updated to prevent stale cookie races
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        response = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // Refresh auth session
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Helper to carry cookies over onto redirect responses
  const createRedirectResponse = (targetPath: string) => {
    const url = request.nextUrl.clone();
    url.pathname = targetPath;
    url.search = "";
    const redirectRes = NextResponse.redirect(url);
    response.cookies.getAll().forEach((cookie) => {
      redirectRes.cookies.set(cookie.name, cookie.value);
    });
    return redirectRes;
  };

  // Protected paths for logged-in users
  const isProtectedPath =
    path.startsWith("/dashboard") ||
    path.startsWith("/vehicles") ||
    path.startsWith("/book") ||
    path.startsWith("/requests") ||
    path.startsWith("/mechanic");

  // If visiting protected page without user, redirect to /auth
  if (isProtectedPath && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth";
    url.searchParams.set("redirectTo", path);
    const redirectRes = NextResponse.redirect(url);
    response.cookies.getAll().forEach((cookie) => {
      redirectRes.cookies.set(cookie.name, cookie.value);
    });
    return redirectRes;
  }

  if (user) {
    // Query public.users for the role at most once per page navigation.
    // Distinguish:
    // 1. Row missing -> default to "customer" (not an error).
    // 2. Query error / timeout -> retry once; if failed, return retry state with HTTP 503.
    // 3. Success -> read role.
    let role: "customer" | "mechanic" = "customer";
    let fetchErrorOccurred = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data: dbUser, error: queryError } = await supabase
          .from("users")
          .select("role")
          .eq("id", user.id)
          .maybeSingle();

        if (queryError) {
          if (attempt === 0) continue; // retry once
          fetchErrorOccurred = true;
          break;
        }

        if (!dbUser) {
          // Row missing in public.users: default to customer, not an error
          role = "customer";
          fetchErrorOccurred = false;
          break;
        }

        role = dbUser.role === "mechanic" ? "mechanic" : "customer";
        fetchErrorOccurred = false;
        break;
      } catch {
        if (attempt === 0) continue; // retry once
        fetchErrorOccurred = true;
        break;
      }
    }

    if (fetchErrorOccurred) {
      const retryHtml = `<!DOCTYPE html>
<html>
<head><title>Service Temporarily Unavailable</title><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background-color: #f9fafb; color: #111827;">
  <div style="background: white; padding: 2rem; border-radius: 0.75rem; border: 1px solid #e5e7eb; max-width: 24rem; width: 90%; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem;">Service Temporarily Unavailable</h2>
    <p style="font-size: 0.875rem; color: #6b7280; margin-bottom: 1.5rem;">We couldn't verify your account session. Please try again.</p>
    <button onclick="window.location.reload()" style="background-color: #2563eb; color: white; padding: 0.5rem 1rem; border: none; border-radius: 0.375rem; font-weight: 500; cursor: pointer; font-size: 0.875rem;">Retry</button>
  </div>
</body>
</html>`;
      const retryResponse = new NextResponse(retryHtml, {
        status: 503,
        headers: {
          "Content-Type": "text/html",
          "Retry-After": "2",
        },
      });
      response.cookies.getAll().forEach((c) => {
        retryResponse.cookies.set(c.name, c.value);
      });
      return retryResponse;
    }

    // Role-based redirects:
    // 1. Mechanics who open customer-only pages (/dashboard, /book, /vehicles/*) -> /mechanic/queue
    const isCustomerOnly =
      path.startsWith("/dashboard") ||
      path.startsWith("/book") ||
      path.startsWith("/vehicles");

    if (role === "mechanic" && isCustomerOnly) {
      return createRedirectResponse("/mechanic/queue");
    }

    // 2. Non-mechanics who open /mechanic/* -> /dashboard
    if (role !== "mechanic" && path.startsWith("/mechanic")) {
      return createRedirectResponse("/dashboard");
    }

    // 3. Authenticated user visiting /auth -> respective home
    if (path === "/auth") {
      return createRedirectResponse(role === "mechanic" ? "/mechanic/queue" : "/dashboard");
    }
  }

  return response;
}

export const config = {
  // Restrict matcher to page routes only: exclude api, _next, and static files
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

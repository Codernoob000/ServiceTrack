import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
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

  const path = request.nextUrl.pathname;

  // Helper to carry updated cookies over on redirect
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
    // Read role from public.users (not user_metadata)
    let role: "customer" | "mechanic" = "customer";
    try {
      const { data: dbUser } = await supabase
        .from("users")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();

      if (dbUser?.role === "mechanic") {
        role = "mechanic";
      } else if (dbUser?.role === "customer") {
        role = "customer";
      } else if (user.app_metadata?.role === "mechanic") {
        role = "mechanic";
      }
    } catch {
      if (user.app_metadata?.role === "mechanic") {
        role = "mechanic";
      }
    }

    // Role-based redirects for authenticated users:
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
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

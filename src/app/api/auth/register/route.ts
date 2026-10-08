import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { registerSchema } from "@/lib/validation";
import { getServiceRoleClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown-ip";

    // Rate limiting: max 5 registration requests per minute per IP
    const rateLimit = await checkRateLimit(`reg:${ip}`, 5, 60);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid registration details. Please verify your input." },
        { status: 400 }
      );
    }

    const { email, password, name, phone, role, inviteCode } = parsed.data;

    // Strict constant-time verification for mechanic invite code
    if (role === "mechanic") {
      const serverInvite = process.env.MECHANIC_INVITE_CODE || "";
      if (!inviteCode || !serverInvite) {
        return NextResponse.json(
          { error: "Invalid registration details." },
          { status: 400 }
        );
      }

      const inputBuffer = Buffer.from(inviteCode.trim());
      const expectedBuffer = Buffer.from(serverInvite.trim());

      if (
        inputBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(inputBuffer, expectedBuffer)
      ) {
        return NextResponse.json(
          { error: "Invalid registration details." },
          { status: 400 }
        );
      }
    }

    const admin = getServiceRoleClient();

    // Create user in Supabase Auth
    // Note: The database trigger handle_new_user() will ALWAYS insert role='customer' into public.users.
    const { data: userData, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        name,
        phone: phone || null,
      },
    });

    if (createError || !userData.user) {
      // Return generic error message to prevent account enumeration
      return NextResponse.json(
        { error: "Unable to complete registration. Please check your credentials." },
        { status: 400 }
      );
    }

    const userId = userData.user.id;

    // If registered as mechanic, promote server-side:
    // Update both public.users.role (authorization source of truth) and app_metadata.role
    if (role === "mechanic") {
      await admin.auth.admin.updateUserById(userId, {
        app_metadata: { role: "mechanic" },
      });

      const { error: updateError } = await admin
        .from("users")
        .update({ role: "mechanic" })
        .eq("id", userId);

      if (updateError) {
        console.error("Failed to update public.users role to mechanic:", updateError);
      }
    }

    return NextResponse.json(
      { success: true, message: "Account created successfully." },
      { status: 201 }
    );
  } catch (err) {
    console.error("Register route error:", err);
    return NextResponse.json(
      { error: "A server error occurred. Please try again." },
      { status: 500 }
    );
  }
}

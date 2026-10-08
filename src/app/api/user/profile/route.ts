import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { profileUpdateSchema } from "@/lib/validation";
import { getServiceRoleClient } from "@/lib/supabase/admin";

export async function PATCH(request: NextRequest) {
  try {
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = profileUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid profile data provided." },
        { status: 400 }
      );
    }

    const { name, phone } = parsed.data;
    const admin = getServiceRoleClient();

    // Whitelist only name and phone columns -- role and email are NEVER modifiable here
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone;

    const { error: updateError } = await admin
      .from("users")
      .update(updateData)
      .eq("id", user.id);

    if (updateError) {
      return NextResponse.json(
        { error: "Failed to update profile." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, message: "Profile updated." });
  } catch (err) {
    console.error("Profile route error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { getAuthenticatedUser } from "@/lib/auth";
import { getServiceRoleClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();

    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = getServiceRoleClient();
    const { data: vehicle, error: vError } = await admin
      .from("vehicles")
      .select("id, user_id, public_token, public_history_enabled, is_active")
      .eq("id", id)
      .maybeSingle();

    if (vError || !vehicle) {
      return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
    }

    // Only the vehicle owner has access; mechanics and other customers get generic 404
    if (vehicle.user_id !== user.id) {
      return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const publicUrl = `${baseUrl}/h/${vehicle.public_token}`;

    const qrCodeSvg = await QRCode.toString(publicUrl, {
      type: "svg",
      margin: 2,
      width: 256,
    });

    return NextResponse.json({
      public_url: publicUrl,
      enabled: vehicle.public_history_enabled,
      qr_code: qrCodeSvg,
      token: vehicle.public_token,
    });
  } catch (err) {
    console.error("Vehicle public link GET error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { getAuthenticatedUser } from "@/lib/auth";
import { getServiceRoleClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();

    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = getServiceRoleClient();
    const { data: newToken, error: rpcError } = await admin.rpc("rotate_vehicle_token", {
      p_vehicle_id: id,
      p_caller_id: user.id,
    });

    if (rpcError) {
      const code = rpcError.code;
      // P0020: not found, P0021: forbidden/not owner -> return 404 to avoid revealing existence
      if (code === "P0020" || code === "P0021") {
        return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
      }

      console.error("rotate_vehicle_token error:", rpcError);
      return NextResponse.json({ error: "Failed to rotate token." }, { status: 500 });
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const publicUrl = `${baseUrl}/h/${newToken}`;

    const qrCodeSvg = await QRCode.toString(publicUrl, {
      type: "svg",
      margin: 2,
      width: 256,
    });

    return NextResponse.json({
      public_url: publicUrl,
      token: newToken,
      qr_code: qrCodeSvg,
    });
  } catch (err) {
    console.error("Rotate vehicle link error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

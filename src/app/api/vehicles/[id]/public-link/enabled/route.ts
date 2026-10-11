import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/auth";
import { getServiceRoleClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const enabledSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();

    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const parsed = enabledSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input: enabled must be a boolean." },
        { status: 400 }
      );
    }

    const admin = getServiceRoleClient();
    const { data: updatedStatus, error: rpcError } = await admin.rpc("set_public_history", {
      p_vehicle_id: id,
      p_caller_id: user.id,
      p_enabled: parsed.data.enabled,
    });

    if (rpcError) {
      const code = rpcError.code;
      // P0020: not found, P0021: not owner -> 404
      if (code === "P0020" || code === "P0021") {
        return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
      }
      // P0022: invalid input -> 400
      if (code === "P0022") {
        return NextResponse.json({ error: "Invalid input." }, { status: 400 });
      }

      console.error("set_public_history error:", rpcError);
      return NextResponse.json({ error: "Failed to update history setting." }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      enabled: updatedStatus,
    });
  } catch (err) {
    console.error("Set public history error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

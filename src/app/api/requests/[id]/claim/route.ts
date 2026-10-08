import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
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

    if (profile.role !== "mechanic") {
      return NextResponse.json(
        { error: "Forbidden: Only mechanics can claim requests." },
        { status: 403 }
      );
    }

    const admin = getServiceRoleClient();

    // Verify request exists, is in 'booked' status, and unassigned
    const { data: currentReq, error: fetchError } = await admin
      .from("requests")
      .select("id, status, mechanic_id, vehicle_id")
      .eq("id", id)
      .maybeSingle();

    if (fetchError || !currentReq) {
      return NextResponse.json({ error: "Request not found." }, { status: 404 });
    }

    if (currentReq.status !== "booked" || currentReq.mechanic_id !== null) {
      return NextResponse.json(
        { error: "Request is no longer available or has already been claimed." },
        { status: 409 }
      );
    }

    // Call atomic claim_request() RPC using the user session client
    // Inside PostgreSQL:
    // - checks auth.uid()
    // - verifies public.users.role == 'mechanic'
    // - sets mechanic_id = auth.uid() AND status = 'inspecting' atomically
    const supabase = await createClient();
    const { data: rowsAffected, error: rpcError } = await supabase.rpc("claim_request", {
      p_request_id: id,
    });

    if (rpcError) {
      console.error("RPC claim_request error:", rpcError);
      return NextResponse.json(
        { error: "Unable to claim request at this time." },
        { status: 500 }
      );
    }

    if (rowsAffected !== 1) {
      return NextResponse.json(
        { error: "Request was claimed by another mechanic." },
        { status: 409 }
      );
    }

    // Fetch updated request
    const { data: updated } = await admin
      .from("requests")
      .select(`*, vehicle:vehicles(*)`)
      .eq("id", id)
      .single();

    return NextResponse.json({
      success: true,
      message: "Request assigned and moved to inspecting.",
      request: updated,
    });
  } catch (err) {
    console.error("Claim request route error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

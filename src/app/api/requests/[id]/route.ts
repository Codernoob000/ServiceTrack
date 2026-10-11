import { NextRequest, NextResponse } from "next/server";
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
    const { data: req, error } = await admin
      .from("requests")
      .select(`
        *,
        vehicle:vehicles(*)
      `)
      .eq("id", id)
      .maybeSingle();

    if (error || !req) {
      return NextResponse.json({ error: "Request not found." }, { status: 404 });
    }

    // Ownership check: customers can only view requests for their own vehicles
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vehicleOwnerId = (req.vehicle as any)?.user_id;
    if (profile.role === "customer" && vehicleOwnerId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Mechanic check: must be assigned mechanic or the request is unassigned in open queue
    if (profile.role === "mechanic") {
      const isAssigned = req.mechanic_id === user.id;
      const isOpenBooked = req.mechanic_id === null && req.status === "booked";
      if (!isAssigned && !isOpenBooked) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // Fetch mechanic's display name server-side if assigned
    let mechanicName: string | null = null;
    if (req.mechanic_id) {
      const { data: mechanicUser } = await admin
        .from("users")
        .select("name")
        .eq("id", req.mechanic_id)
        .maybeSingle();
      if (mechanicUser?.name) {
        mechanicName = mechanicUser.name;
      }
    }

    const responseReq: Record<string, unknown> = {
      ...req,
      mechanic: mechanicName ? { name: mechanicName } : null,
      mechanic_name: mechanicName,
    };

    // Customers must never see the mechanic's user ID
    if (profile.role === "customer") {
      delete responseReq.mechanic_id;
    }

    return NextResponse.json({
      request: responseReq,
      user_role: profile.role,
      user_id: user.id,
    });
  } catch (err) {
    console.error("Request GET by id error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

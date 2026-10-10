import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { requestTransitionSchema } from "@/lib/validation";
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

    const body = await request.json();
    const parsed = requestTransitionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid transition action." }, { status: 400 });
    }

    const { action } = parsed.data;
    const admin = getServiceRoleClient();

    // Fetch current request details along with vehicle ownership
    const { data: currentReq, error: fetchError } = await admin
      .from("requests")
      .select(`
        id,
        status,
        mechanic_id,
        vehicle_id,
        vehicle:vehicles (user_id)
      `)
      .eq("id", id)
      .maybeSingle();

    if (fetchError || !currentReq) {
      return NextResponse.json({ error: "Request not found." }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vehicleOwnerId = (currentReq.vehicle as any)?.user_id;
    const isOwner = vehicleOwnerId === user.id;
    const isAssignedMechanic = currentReq.mechanic_id === user.id;

    if (action === "cancel") {
      // Cancel is strictly for the vehicle owner only
      if (!isOwner) {
        return NextResponse.json(
          { error: "Forbidden: Only the vehicle owner can cancel this request." },
          { status: 403 }
        );
      }

      // Cancelling is allowed strictly before repairing
      const cancellableStatuses = ["booked", "inspecting", "awaiting_approval"];
      if (!cancellableStatuses.includes(currentReq.status)) {
        return NextResponse.json(
          { error: `Cannot cancel a service request in '${currentReq.status}' status.` },
          { status: 400 }
        );
      }

      const { data: updated, error: updateError } = await admin
        .from("requests")
        .update({ status: "cancelled" })
        .eq("id", id)
        .select(`*, vehicle:vehicles(*)`)
        .single();

      if (updateError) {
        console.error("Transition to cancelled error:", updateError);
        return NextResponse.json({ error: "Failed to cancel service request." }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: "Service request cancelled.",
        request: updated,
      });
    }

    if (action === "release") {
      // Release is strictly for the currently assigned mechanic
      if (!isAssignedMechanic || profile.role !== "mechanic") {
        return NextResponse.json(
          { error: "Forbidden: Only the assigned mechanic can release this job." },
          { status: 403 }
        );
      }

      // Return request to booked status with mechanic unassigned
      const { data: updated, error: updateError } = await admin
        .from("requests")
        .update({ status: "booked", mechanic_id: null })
        .eq("id", id)
        .select(`*, vehicle:vehicles(*)`)
        .single();

      if (updateError) {
        console.error("Release job error:", updateError);
        return NextResponse.json({ error: "Failed to release service request." }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: "Job released back to queue.",
        request: updated,
      });
    }

    if (action === "start_inspection") {
      // Customer cannot start inspection
      if (profile.role !== "mechanic") {
        return NextResponse.json(
          { error: "Forbidden: Only mechanics can start vehicle inspection." },
          { status: 403 }
        );
      }

      if (currentReq.status !== "booked") {
        return NextResponse.json(
          { error: `Cannot start inspection from '${currentReq.status}' status.` },
          { status: 400 }
        );
      }

      const { data: updated, error: updateError } = await admin
        .from("requests")
        .update({ status: "inspecting", mechanic_id: user.id })
        .eq("id", id)
        .select(`*, vehicle:vehicles(*)`)
        .single();

      if (updateError) {
        return NextResponse.json({ error: "Failed to start inspection." }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: "Inspection started.",
        request: updated,
      });
    }

    if (action === "complete") {
      // Transitioning booked to done is rejected
      if (currentReq.status !== "repairing") {
        return NextResponse.json(
          { error: `Cannot complete service request directly from '${currentReq.status}' status.` },
          { status: 400 }
        );
      }

      if (!isAssignedMechanic) {
        return NextResponse.json(
          { error: "Forbidden: Only assigned mechanic can complete repairs." },
          { status: 403 }
        );
      }

      const { data: updated, error: updateError } = await admin
        .from("requests")
        .update({ status: "done" })
        .eq("id", id)
        .select(`*, vehicle:vehicles(*)`)
        .single();

      if (updateError) {
        return NextResponse.json({ error: "Failed to complete service request." }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: "Service request completed.",
        request: updated,
      });
    }

    return NextResponse.json({ error: "Unsupported transition action." }, { status: 400 });
  } catch (err) {
    console.error("Transition route error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

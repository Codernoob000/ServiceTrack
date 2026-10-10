import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { requestTransitionSchema } from "@/lib/validation";
import { getServiceRoleClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function handleTransition(request: NextRequest, { params }: RouteParams) {
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
      // Release is executed via atomic SQL function release_inspection_job
      // Locks request FOR UPDATE, verifies assigned mechanic caller, checks status == inspecting,
      // and verifies 0 images uploaded.
      if (!isAssignedMechanic || profile.role !== "mechanic") {
        return NextResponse.json(
          { error: "Forbidden: Only the assigned mechanic can release this job." },
          { status: 403 }
        );
      }

      const { error: rpcError } = await admin.rpc("release_inspection_job", {
        p_request_id: id,
        p_caller_id: user.id,
      });

      if (rpcError) {
        const msg = rpcError.message || "";
        if (rpcError.code === "P0002") {
          return NextResponse.json({ error: "Request not found." }, { status: 404 });
        }
        if (rpcError.code === "P0003") {
          return NextResponse.json({ error: "Forbidden: Only the assigned mechanic can release this job." }, { status: 403 });
        }
        if (rpcError.code === "P0004" || rpcError.code === "P0006") {
          return NextResponse.json({ error: msg }, { status: 400 });
        }
        console.error("RPC release_inspection_job error:", rpcError);
        return NextResponse.json({ error: msg || "Failed to release job." }, { status: 500 });
      }

      const { data: updated } = await admin
        .from("requests")
        .select(`*, vehicle:vehicles(*)`)
        .eq("id", id)
        .single();

      return NextResponse.json({
        success: true,
        message: "Job released back to queue.",
        request: updated,
      });
    }

    if (action === "submit_report") {
      // Submit report is executed via atomic SQL function submit_inspection_report
      // Locks request FOR UPDATE, verifies caller is assigned mechanic, verifies status == inspecting,
      // verifies >= 1 image AND >= 1 pin with repair item, and transitions to 'awaiting_approval'.
      if (!isAssignedMechanic || profile.role !== "mechanic") {
        return NextResponse.json(
          { error: "Forbidden: Only the assigned mechanic can submit inspection reports." },
          { status: 403 }
        );
      }

      const { error: rpcError } = await admin.rpc("submit_inspection_report", {
        p_request_id: id,
        p_caller_id: user.id,
      });

      if (rpcError) {
        const msg = rpcError.message || "";
        if (rpcError.code === "P0002") {
          return NextResponse.json({ error: "Request not found." }, { status: 404 });
        }
        if (rpcError.code === "P0003") {
          return NextResponse.json({ error: "Forbidden: Only the assigned mechanic can submit inspection reports." }, { status: 403 });
        }
        if (rpcError.code === "P0004" || rpcError.code === "P0005" || rpcError.code === "P0008") {
          return NextResponse.json({ error: msg }, { status: 400 });
        }
        console.error("RPC submit_inspection_report error:", rpcError);
        return NextResponse.json({ error: msg || "Failed to submit inspection report." }, { status: 500 });
      }

      const { data: updated } = await admin
        .from("requests")
        .select(`*, vehicle:vehicles(*)`)
        .eq("id", id)
        .single();

      return NextResponse.json({
        success: true,
        message: "Inspection report submitted.",
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

export async function POST(request: NextRequest, context: RouteParams) {
  return handleTransition(request, context);
}

export async function PATCH(request: NextRequest, context: RouteParams) {
  return handleTransition(request, context);
}

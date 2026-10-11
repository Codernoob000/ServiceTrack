import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getServiceRoleClient } from "@/lib/supabase/admin";
import { pinCreateSchema } from "@/lib/validation";
import { SERVICE_IMAGES_BUCKET } from "@/lib/constants";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/requests/[id]/pins
 * Creates a defect pin and repair item atomically via create_pin_with_item RPC.
 * - Authenticated assigned mechanic only
 * - Request status must be 'inspecting' (returns 409 if in incompatible state)
 * - Image must belong to the specified request
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (profile.role !== "mechanic") {
      return NextResponse.json(
        { error: "Forbidden: Only mechanics can create defect pins." },
        { status: 403 }
      );
    }

    const admin = getServiceRoleClient();

    // Verify request status and assigned mechanic upfront
    const { data: currentReq, error: reqError } = await admin
      .from("requests")
      .select("id, status, mechanic_id")
      .eq("id", id)
      .maybeSingle();

    if (reqError || !currentReq) {
      return NextResponse.json({ error: "Request not found." }, { status: 404 });
    }

    if (currentReq.mechanic_id !== user.id) {
      return NextResponse.json(
        { error: "Forbidden: Only the assigned mechanic can create defect pins." },
        { status: 403 }
      );
    }

    if (currentReq.status !== "inspecting") {
      return NextResponse.json(
        { error: `Cannot create pins: request status is '${currentReq.status}' (must be 'inspecting').` },
        { status: 409 }
      );
    }

    const body = await request.json();
    const parsed = pinCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid pin data.", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const {
      image_id,
      x,
      y,
      part_name,
      severity,
      notes,
      description,
      estimate,
    } = parsed.data;

    // Call atomic SQL RPC create_pin_with_item
    // Strictly pass authenticated user's ID as p_caller_id
    const { data: result, error: rpcError } = await admin.rpc(
      "create_pin_with_item",
      {
        p_request_id: id,
        p_caller_id: user.id,
        p_image_id: image_id,
        p_x: x,
        p_y: y,
        p_part_name: part_name,
        p_severity: severity,
        p_notes: notes || null,
        p_description: description,
        p_estimate: estimate,
      }
    );

    if (rpcError) {
      const msg = rpcError.message || "";
      if (rpcError.code === "P0002" || msg.includes("does not belong to request") || msg.includes("not found")) {
        return NextResponse.json({ error: msg || "Image not found for request." }, { status: 404 });
      }
      if (rpcError.code === "P0003" || msg.includes("Unauthorized") || msg.includes("not the assigned mechanic")) {
        return NextResponse.json({ error: "Forbidden: Not the assigned mechanic." }, { status: 403 });
      }
      if (rpcError.code === "P0004" || msg.includes("must be inspecting") || msg.includes("Conflict")) {
        return NextResponse.json({ error: msg || "Request is not in inspecting status." }, { status: 409 });
      }
      if (rpcError.code === "23514" || msg.includes("check")) {
        return NextResponse.json({ error: msg || "Data constraint violation." }, { status: 400 });
      }

      console.error("RPC create_pin_with_item error:", rpcError);
      return NextResponse.json({ error: msg || "Failed to create pin." }, { status: 500 });
    }

    return NextResponse.json(
      {
        success: true,
        pin: result,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("Create pin route error:", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

/**
 * GET /api/requests/[id]/pins
 * Lists all defect pins with their repair items for the request.
 * Access rules:
 * - Assigned mechanic: anytime
 * - Vehicle owner: ONLY when status is 'awaiting_approval', 'repairing', or 'done' (403 before)
 * - Everyone else: 403 Forbidden (including unassigned mechanics; no open-queue access)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = getServiceRoleClient();

    // Verify request access permissions and status
    const { data: currentReq, error: reqError } = await admin
      .from("requests")
      .select("id, status, mechanic_id, vehicle:vehicles(user_id)")
      .eq("id", id)
      .maybeSingle();

    if (reqError || !currentReq) {
      return NextResponse.json({ error: "Request not found." }, { status: 404 });
    }

    const vehicleOwnerId = (currentReq.vehicle as unknown as { user_id: string })?.user_id;
    const isOwner = vehicleOwnerId === user.id;
    const isAssignedMechanic = profile.role === "mechanic" && currentReq.mechanic_id === user.id;

    // Vehicle owner access only allowed in awaiting_approval, repairing, or done
    const ownerAllowedStatuses = ["awaiting_approval", "repairing", "done"];
    const isOwnerWithAccess =
      profile.role === "customer" &&
      isOwner &&
      ownerAllowedStatuses.includes(currentReq.status);

    if (!isAssignedMechanic && !isOwnerWithAccess) {
      return NextResponse.json(
        { error: "Forbidden: You do not have permission to view defect pins for this request." },
        { status: 403 }
      );
    }

    // Retrieve all images associated with this request
    const { data: images, error: imagesError } = await admin
      .from("images")
      .select("id")
      .eq("request_id", id);

    if (imagesError) {
      return NextResponse.json({ error: "Failed to query images." }, { status: 500 });
    }

    if (!images || images.length === 0) {
      return NextResponse.json({ pins: [] });
    }

    const imageIds = images.map((i) => i.id);

    // Retrieve pins with repair items
    const { data: pins, error: pinsError } = await admin
      .from("pins")
      .select(`
        *,
        repair_item:repair_items(*)
      `)
      .in("image_id", imageIds)
      .order("created_at", { ascending: true });

    if (pinsError) {
      console.error("Query pins error:", pinsError);
      return NextResponse.json({ error: "Failed to fetch pins." }, { status: 500 });
    }

    // Flatten repair_item array to single object if needed
    const normalizedPins = (pins || []).map((pin) => {
      const pinObj = pin as unknown as { repair_item?: unknown };
      const item = Array.isArray(pinObj.repair_item)
        ? pinObj.repair_item[0] ?? null
        : pinObj.repair_item ?? null;
      return {
        ...pin,
        repair_item: item,
      };
    });

    const isRepairingOrDone = currentReq.status === "repairing" || currentReq.status === "done";

    // Collect all after_photo paths for approved items when status is repairing or done
    const afterPhotoPaths: string[] = [];
    if (isRepairingOrDone) {
      for (const p of normalizedPins) {
        const item = p.repair_item as { approval_status?: string; after_photo_url?: string | null } | null;
        if (item && item.approval_status === "approved" && item.after_photo_url && item.after_photo_url.startsWith("requests/")) {
          afterPhotoPaths.push(item.after_photo_url);
        }
      }
    }

    const signedMap = new Map<string, string>();
    if (afterPhotoPaths.length > 0) {
      try {
        const { data: signedResults } = await admin.storage
          .from(SERVICE_IMAGES_BUCKET)
          .createSignedUrls(afterPhotoPaths, 600);

        if (signedResults) {
          for (const sr of signedResults) {
            if (sr.signedUrl && sr.path && sr.signedUrl.trim() !== "") {
              signedMap.set(sr.path, sr.signedUrl);
            }
          }
        }
      } catch {
        // Do not fail the whole response if storage fails
      }
    }

    const finalPins = normalizedPins.map((pin) => {
      const item = pin.repair_item as { approval_status?: string; after_photo_url?: string | null } | null;
      if (!item) return pin;

      if (isRepairingOrDone && item.approval_status === "approved" && item.after_photo_url) {
        const rawSigned = signedMap.get(item.after_photo_url);
        const signedUrl = rawSigned && rawSigned.trim() !== "" ? rawSigned : null;
        return {
          ...pin,
          repair_item: {
            ...item,
            after_photo_url: signedUrl,
          },
        };
      }

      return {
        ...pin,
        repair_item: {
          ...item,
          after_photo_url: null,
        },
      };
    });

    return NextResponse.json({ pins: finalPins });
  } catch (err) {
    console.error("GET pins route error:", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

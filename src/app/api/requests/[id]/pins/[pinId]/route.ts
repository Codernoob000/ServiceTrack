import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getServiceRoleClient } from "@/lib/supabase/admin";
import { pinUpdateSchema } from "@/lib/validation";

interface RouteParams {
  params: Promise<{ id: string; pinId: string }>;
}

const ALLOWED_PATCH_FIELDS = new Set([
  "x",
  "y",
  "part_name",
  "severity",
  "notes",
  "description",
  "estimate",
]);

/**
 * PATCH /api/requests/[id]/pins/[pinId]
 * Updates a defect pin and/or its associated repair item.
 * - Authenticated assigned mechanic only
 * - Request status must be 'inspecting' (returns 409 if in incompatible state)
 * - Strict whitelist: only description, estimate, part_name, severity, notes, x, y.
 * - Any attempt to modify lifecycle fields (approval_status, after_photo_url, completed_at)
 *   or immutable fields (id, image_id, pin_id, created_at) is strictly rejected with 400.
 * - Verifies pin belongs to this specific service request (returns 404 if from different request).
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, pinId } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (profile.role !== "mechanic") {
      return NextResponse.json(
        { error: "Forbidden: Only mechanics can update defect pins." },
        { status: 403 }
      );
    }

    const body = await request.json();

    // Strict whitelist check: check every key in body against whitelist
    const incomingKeys = Object.keys(body);
    if (incomingKeys.length === 0) {
      return NextResponse.json(
        { error: "No fields provided to update." },
        { status: 400 }
      );
    }

    const disallowedKeys = incomingKeys.filter((k) => !ALLOWED_PATCH_FIELDS.has(k));
    if (disallowedKeys.length > 0) {
      return NextResponse.json(
        {
          error: `Disallowed fields in update request: ${disallowedKeys.join(", ")}. Only description, estimate, part_name, severity, notes, x, and y may be updated.`,
        },
        { status: 400 }
      );
    }

    const parsed = pinUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid update data.", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const admin = getServiceRoleClient();

    // Verify request status and assigned mechanic
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
        { error: "Forbidden: Only assigned mechanic can update pins." },
        { status: 403 }
      );
    }

    if (currentReq.status !== "inspecting") {
      return NextResponse.json(
        { error: `Cannot update pins: request status is '${currentReq.status}' (must be 'inspecting').` },
        { status: 409 }
      );
    }

    // Verify pin belongs to an image of this specific request
    const { data: currentPin, error: pinFindErr } = await admin
      .from("pins")
      .select("id, image_id, image:images!inner(request_id)")
      .eq("id", pinId)
      .maybeSingle();

    if (pinFindErr || !currentPin) {
      return NextResponse.json({ error: "Pin not found." }, { status: 404 });
    }

    const pinReqId = (currentPin.image as unknown as { request_id: string })?.request_id;
    if (pinReqId !== id) {
      return NextResponse.json(
        { error: "Pin does not belong to this service request." },
        { status: 404 }
      );
    }

    const { x, y, part_name, severity, notes, description, estimate } = parsed.data;

    // 1. Update pin fields if any provided
    const pinUpdates: Record<string, unknown> = {};
    if (x !== undefined) pinUpdates.x = x;
    if (y !== undefined) pinUpdates.y = y;
    if (part_name !== undefined) pinUpdates.part_name = part_name;
    if (severity !== undefined) pinUpdates.severity = severity;
    if (notes !== undefined) pinUpdates.notes = notes;

    let updatedPinRow: Record<string, unknown> | null = null;
    if (Object.keys(pinUpdates).length > 0) {
      const { data: updatedPin, error: pinUpdateErr } = await admin
        .from("pins")
        .update(pinUpdates)
        .eq("id", pinId)
        .select()
        .single();

      if (pinUpdateErr) {
        console.error("Pin update error:", pinUpdateErr);
        return NextResponse.json(
          { error: pinUpdateErr.message || "Failed to update pin." },
          { status: 400 }
        );
      }
      updatedPinRow = updatedPin;
    } else {
      const { data: existingPin } = await admin
        .from("pins")
        .select()
        .eq("id", pinId)
        .single();
      updatedPinRow = existingPin;
    }

    // 2. Update repair item fields if any provided
    const itemUpdates: Record<string, unknown> = {};
    if (description !== undefined) itemUpdates.description = description;
    if (estimate !== undefined) itemUpdates.estimate = estimate;

    let updatedItemRow: Record<string, unknown> | null = null;
    if (Object.keys(itemUpdates).length > 0) {
      const { data: updatedItem, error: itemUpdateErr } = await admin
        .from("repair_items")
        .update(itemUpdates)
        .eq("pin_id", pinId)
        .select()
        .single();

      if (itemUpdateErr) {
        console.error("Repair item update error:", itemUpdateErr);
        return NextResponse.json(
          { error: itemUpdateErr.message || "Failed to update repair item." },
          { status: 400 }
        );
      }
      updatedItemRow = updatedItem;
    } else {
      const { data: existingItem } = await admin
        .from("repair_items")
        .select()
        .eq("pin_id", pinId)
        .maybeSingle();
      updatedItemRow = existingItem;
    }

    return NextResponse.json({
      success: true,
      pin: {
        ...updatedPinRow,
        repair_item: updatedItemRow,
      },
    });
  } catch (err) {
    console.error("PATCH pin route error:", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

/**
 * DELETE /api/requests/[id]/pins/[pinId]
 * Deletes a defect pin (repair item is cascade-deleted).
 * - Authenticated assigned mechanic only
 * - Request status must be 'inspecting' (returns 409 if in incompatible state)
 * - Verifies pin belongs to this specific request (returns 404 if from different request).
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, pinId } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (profile.role !== "mechanic") {
      return NextResponse.json(
        { error: "Forbidden: Only mechanics can delete defect pins." },
        { status: 403 }
      );
    }

    const admin = getServiceRoleClient();

    // Verify request
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
        { error: "Forbidden: Only assigned mechanic can delete pins." },
        { status: 403 }
      );
    }

    if (currentReq.status !== "inspecting") {
      return NextResponse.json(
        { error: `Cannot delete pins: request status is '${currentReq.status}' (must be 'inspecting').` },
        { status: 409 }
      );
    }

    // Verify pin belongs to this specific request
    const { data: pinRow, error: pinFindErr } = await admin
      .from("pins")
      .select("id, image:images!inner(request_id)")
      .eq("id", pinId)
      .maybeSingle();

    if (pinFindErr || !pinRow) {
      return NextResponse.json({ error: "Pin not found." }, { status: 404 });
    }

    const pinReqId = (pinRow.image as unknown as { request_id: string })?.request_id;
    if (pinReqId !== id) {
      return NextResponse.json(
        { error: "Pin does not belong to this service request." },
        { status: 404 }
      );
    }

    // Delete pin (trigger enforces inspecting status, cascade deletes repair_item)
    const { error: deleteErr } = await admin
      .from("pins")
      .delete()
      .eq("id", pinId);

    if (deleteErr) {
      console.error("Delete pin error:", deleteErr);
      return NextResponse.json(
        { error: deleteErr.message || "Failed to delete pin." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Pin deleted successfully.",
    });
  } catch (err) {
    console.error("DELETE pin route error:", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

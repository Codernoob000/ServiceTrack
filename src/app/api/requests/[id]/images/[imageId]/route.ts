import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getServiceRoleClient } from "@/lib/supabase/admin";
import { SERVICE_IMAGES_BUCKET } from "@/lib/constants";

interface RouteParams {
  params: Promise<{ id: string; imageId: string }>;
}

/**
 * DELETE /api/requests/[id]/images/[imageId]
 * Deletes an inspection image and its associated pins and repair items.
 * - Authenticated assigned mechanic only
 * - Request status must be 'inspecting' (returns 409 if in incompatible state)
 * - Verifies image belongs to this request (returns 404 if from different request)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, imageId } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (profile.role !== "mechanic") {
      return NextResponse.json(
        { error: "Forbidden: Only mechanics can delete inspection images." },
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
        { error: "Forbidden: Only the assigned mechanic can delete images for this request." },
        { status: 403 }
      );
    }

    if (currentReq.status !== "inspecting") {
      return NextResponse.json(
        { error: `Cannot delete images: request status is '${currentReq.status}' (must be 'inspecting').` },
        { status: 409 }
      );
    }

    // Find image and verify it belongs to this specific request
    const { data: targetImage, error: findError } = await admin
      .from("images")
      .select("id, storage_path, request_id")
      .eq("id", imageId)
      .maybeSingle();

    if (findError || !targetImage || targetImage.request_id !== id) {
      return NextResponse.json(
        { error: "Image not found for this service request." },
        { status: 404 }
      );
    }

    // Delete row from database (trigger enforces inspecting status)
    const { error: deleteDbError } = await admin
      .from("images")
      .delete()
      .eq("id", imageId)
      .eq("request_id", id);

    if (deleteDbError) {
      console.error("Database delete image error:", deleteDbError);
      return NextResponse.json(
        { error: deleteDbError.message || "Failed to delete image record." },
        { status: 500 }
      );
    }

    // Delete from storage bucket
    if (targetImage.storage_path) {
      await admin.storage
        .from(SERVICE_IMAGES_BUCKET)
        .remove([targetImage.storage_path]);
    }

    return NextResponse.json({
      success: true,
      message: "Image deleted successfully.",
    });
  } catch (err) {
    console.error("DELETE image route error:", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

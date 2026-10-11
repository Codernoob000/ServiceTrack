import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getServiceRoleClient } from "@/lib/supabase/admin";
import { SERVICE_IMAGES_BUCKET } from "@/lib/constants";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/requests/[id]/invoice
 * Returns invoice data with approved repair items only and server-computed total.
 * - Allowed ONLY for vehicle owner and assigned mechanic
 * - Allowed ONLY when status is 'repairing' or 'done' (403 for other statuses)
 * - Returns 403 for unassigned mechanics or other users
 * - Customers must NEVER see the mechanic's user ID
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = getServiceRoleClient();

    // 1. Fetch service request and vehicle details
    const { data: currentReq, error: reqError } = await admin
      .from("requests")
      .select(`
        id,
        status,
        created_at,
        preferred_date,
        mechanic_id,
        vehicle:vehicles (
          id,
          brand,
          model,
          year,
          plate,
          user_id
        )
      `)
      .eq("id", id)
      .maybeSingle();

    if (reqError || !currentReq) {
      return NextResponse.json({ error: "Request not found." }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vehicleOwnerId = (currentReq.vehicle as any)?.user_id;
    const isOwner = vehicleOwnerId === user.id;
    const isAssignedMechanic = profile.role === "mechanic" && currentReq.mechanic_id === user.id;

    // Access check: only vehicle owner or assigned mechanic
    if (!isOwner && !isAssignedMechanic) {
      return NextResponse.json(
        { error: "Forbidden: You do not have permission to view this invoice." },
        { status: 403 }
      );
    }

    // Status check: only allowed when status is 'repairing' or 'done'
    if (currentReq.status !== "repairing" && currentReq.status !== "done") {
      return NextResponse.json(
        { error: "Forbidden: Invoice is only available when status is repairing or done." },
        { status: 403 }
      );
    }

    // 2. Fetch images belonging to this request
    const { data: images, error: imagesError } = await admin
      .from("images")
      .select("id")
      .eq("request_id", id);

    if (imagesError) {
      console.error("Query images for invoice error:", imagesError);
      return NextResponse.json({ error: "Failed to load invoice images." }, { status: 500 });
    }

    const imageIds = (images || []).map((img) => img.id);

    // 3. Fetch pins and approved repair items
    let approvedItems: Array<{
      id: string;
      part_name: string;
      description: string;
      estimate: number;
      has_after_photo: boolean;
      after_photo_url: string | null;
    }> = [];
    let serverTotal = 0;

    if (imageIds.length > 0) {
      const { data: pins, error: pinsError } = await admin
        .from("pins")
        .select(`
          id,
          part_name,
          repair_item:repair_items(*)
        `)
        .in("image_id", imageIds)
        .order("created_at", { ascending: true });

      if (pinsError) {
        console.error("Query pins for invoice error:", pinsError);
        return NextResponse.json({ error: "Failed to load invoice items." }, { status: 500 });
      }

      // Collect all after_photo paths for approved items
      const afterPhotoPaths: string[] = [];
      for (const pin of pins || []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const item = Array.isArray((pin as any).repair_item)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? (pin as any).repair_item[0]
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          : (pin as any).repair_item;

        if (
          item &&
          item.approval_status === "approved" &&
          item.after_photo_url &&
          typeof item.after_photo_url === "string" &&
          item.after_photo_url.startsWith("requests/")
        ) {
          afterPhotoPaths.push(item.after_photo_url);
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
          // Do not fail the whole response if storage signed URL creation fails
        }
      }

      for (const pin of pins || []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const item = Array.isArray((pin as any).repair_item)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? (pin as any).repair_item[0]
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          : (pin as any).repair_item;

        if (item && item.approval_status === "approved") {
          const est = typeof item.estimate === "number" ? item.estimate : parseInt(item.estimate, 10) || 0;
          serverTotal += est;
          const rawSigned = item.after_photo_url ? signedMap.get(item.after_photo_url) : null;
          const signedUrl = rawSigned && rawSigned.trim() !== "" ? rawSigned : null;

          approvedItems.push({
            id: item.id,
            part_name: pin.part_name,
            description: item.description,
            estimate: est,
            has_after_photo: Boolean(item.after_photo_url),
            after_photo_url: signedUrl,
          });
        }
      }
    }

    // Fetch mechanic's display name if assigned, NEVER revealing user ID
    let mechanicName: string | null = null;
    if (currentReq.mechanic_id) {
      const { data: mechanicUser } = await admin
        .from("users")
        .select("name")
        .eq("id", currentReq.mechanic_id)
        .maybeSingle();

      if (mechanicUser?.name) {
        mechanicName = mechanicUser.name;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vehicleData = currentReq.vehicle as any;

    return NextResponse.json({
      request_id: id,
      status: currentReq.status,
      date: currentReq.created_at,
      preferred_date: currentReq.preferred_date,
      vehicle: {
        brand: vehicleData?.brand || "Unknown",
        model: vehicleData?.model || "Unknown",
        year: vehicleData?.year || null,
        plate: vehicleData?.plate || "Unknown",
      },
      items: approvedItems,
      total: serverTotal,
      mechanic_name: mechanicName,
    });
  } catch (err) {
    console.error("Invoice route error:", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

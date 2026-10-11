import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getServiceRoleClient } from "@/lib/supabase/admin";
import { viewAngleSchema } from "@/lib/validation";
import { SERVICE_IMAGES_BUCKET } from "@/lib/constants";
import sharp from "sharp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB

/**
 * Validates binary signature (magic bytes) to ensure file is genuine JPEG or PNG.
 * Rejects SVG, XML, HTML, or corrupted / polyglot files.
 */
function isValidImageSignature(buf: Buffer): boolean {
  if (buf.length < 8) return false;

  // JPEG magic bytes: FF D8 FF
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (isJpeg) return true;

  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  const isPng =
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a;
  if (isPng) return true;

  return false;
}

/**
 * Checks for SVG markers to explicitly reject SVG images.
 */
function isSvgContent(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024).toString("utf8").toLowerCase();
  return (
    head.includes("<svg") ||
    head.includes("<?xml") ||
    head.includes("<!doctype svg")
  );
}

/**
 * POST /api/requests/[id]/images
 * Uploads an inspection image.
 * - Authenticated assigned mechanic only
 * - Request status must be 'inspecting' (returns 409 if in incompatible state)
 * - Max 4 MB: rejected by Content-Length before parsing, and by actual parsed file/buffer size (returns 413)
 * - Validated by file signature (JPEG or PNG only, SVG rejected)
 * - Server-side re-encoding via sharp (auto-rotate, strip EXIF/GPS, normalize to JPEG)
 * - Stored under requests/{requestId}/{uuid}.jpg in private bucket SERVICE_IMAGES_BUCKET
 * - Returns image record with 10-minute signed URL
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // 1. Check Content-Length header before reading body
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: "Payload too large. Maximum file size is 4 MB." },
        { status: 413 }
      );
    }

    // 2. Authentication check
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (profile.role !== "mechanic") {
      return NextResponse.json(
        { error: "Forbidden: Only mechanics can upload inspection images." },
        { status: 403 }
      );
    }

    const admin = getServiceRoleClient();

    // 3. Verify request exists, is in 'inspecting' status, and caller is assigned mechanic
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
        { error: "Forbidden: Only the assigned mechanic can upload images for this request." },
        { status: 403 }
      );
    }

    if (currentReq.status !== "inspecting") {
      return NextResponse.json(
        { error: `Cannot upload images: request status is '${currentReq.status}' (must be 'inspecting').` },
        { status: 409 }
      );
    }

    // 4. Parse multipart/form-data
    const formData = await request.formData();
    const file = formData.get("file");
    const viewAngleRaw = formData.get("view_angle");

    if (!file || typeof file === "string") {
      return NextResponse.json(
        { error: "Missing file: an image file must be provided." },
        { status: 400 }
      );
    }

    // 5. Check parsed file size from Blob (rejects over 4 MB with 413)
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: "Payload too large. File size exceeds 4 MB limit." },
        { status: 413 }
      );
    }

    // Validate view_angle
    const angleParsed = viewAngleSchema.safeParse(viewAngleRaw);
    if (!angleParsed.success) {
      return NextResponse.json(
        { error: "Invalid view_angle. Must be one of: front, rear, left, right, other." },
        { status: 400 }
      );
    }

    // 6. Read file bytes and validate actual buffer length & magic bytes
    const arrayBuf = await file.arrayBuffer();
    const rawBuffer = Buffer.from(arrayBuf);

    if (rawBuffer.length > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: "Payload too large. File size exceeds 4 MB limit." },
        { status: 413 }
      );
    }

    if (isSvgContent(rawBuffer)) {
      return NextResponse.json(
        { error: "SVG images are not allowed." },
        { status: 400 }
      );
    }

    if (!isValidImageSignature(rawBuffer)) {
      return NextResponse.json(
        { error: "Invalid file signature. Only genuine JPEG and PNG files are accepted." },
        { status: 400 }
      );
    }

    // 7. Server-side re-encoding via sharp to strip EXIF/GPS, auto-rotate, and neutralize polyglots
    let processedBuffer: Buffer;
    try {
      processedBuffer = await sharp(rawBuffer)
        .rotate() // auto-orient based on EXIF before stripping
        .jpeg({ quality: 85, mozjpeg: false }) // re-encode cleanly to JPEG and strip metadata
        .toBuffer();
    } catch (sharpError) {
      console.error("Image re-encoding error:", sharpError);
      return NextResponse.json(
        { error: "Corrupted or unreadable image file." },
        { status: 400 }
      );
    }

    // 8. Generate safe random storage path: requests/{requestId}/{uuid}.jpg
    const randomFileName = `${crypto.randomUUID()}.jpg`;
    const storagePath = `requests/${id}/${randomFileName}`;

    // 9. Upload re-encoded buffer to Supabase Storage with service role into SERVICE_IMAGES_BUCKET
    const { error: uploadError } = await admin.storage
      .from(SERVICE_IMAGES_BUCKET)
      .upload(storagePath, processedBuffer, {
        contentType: "image/jpeg",
        upsert: false,
      });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      return NextResponse.json(
        { error: "Failed to store image in storage bucket." },
        { status: 500 }
      );
    }

    // 10. Insert record into public.images table
    // (Triggers verify 'inspecting' status and cap at 10 images under FOR UPDATE lock)
    const { data: newImage, error: insertError } = await admin
      .from("images")
      .insert({
        request_id: id,
        storage_path: storagePath,
        view_angle: angleParsed.data,
      })
      .select()
      .single();

    if (insertError) {
      // Clean up orphaned storage file if DB insert rejected
      await admin.storage.from(SERVICE_IMAGES_BUCKET).remove([storagePath]);

      if (insertError.message?.includes("Maximum limit of 10")) {
        return NextResponse.json(
          { error: "Maximum limit of 10 images reached for this request." },
          { status: 400 }
        );
      }

      if (insertError.message?.includes("must be inspecting")) {
        return NextResponse.json(
          { error: "Cannot add images: request is no longer in inspecting status." },
          { status: 409 }
        );
      }

      console.error("Database insert image error:", insertError);
      return NextResponse.json(
        { error: insertError.message || "Failed to save image record." },
        { status: 500 }
      );
    }

    // 11. Generate 10-minute signed URL
    const { data: signedData } = await admin.storage
      .from(SERVICE_IMAGES_BUCKET)
      .createSignedUrl(storagePath, 600);

    return NextResponse.json(
      {
        success: true,
        image: {
          ...newImage,
          signed_url: signedData?.signedUrl || null,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("Image upload route error:", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

/**
 * GET /api/requests/[id]/images
 * Returns all inspection images for a request with fresh signed URLs (10 min expiry).
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

    // Verify request ownership and status
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
        { error: "Forbidden: You do not have permission to view inspection images for this request." },
        { status: 403 }
      );
    }

    // Fetch images
    const { data: images, error: imagesError } = await admin
      .from("images")
      .select("*")
      .eq("request_id", id)
      .order("created_at", { ascending: true });

    if (imagesError) {
      console.error("Fetch images error:", imagesError);
      return NextResponse.json({ error: "Failed to fetch images." }, { status: 500 });
    }

    if (!images || images.length === 0) {
      return NextResponse.json({ images: [] });
    }

    // Generate signed URLs in bulk (10 minute expiry) from SERVICE_IMAGES_BUCKET
    const paths = images.map((img) => img.storage_path);
    let signedUrls: Array<{ path: string | null; signedUrl: string | null }> | null = null;
    try {
      const { data } = await admin.storage
        .from(SERVICE_IMAGES_BUCKET)
        .createSignedUrls(paths, 600);
      signedUrls = data;
    } catch {
      // Do not fail the whole response if storage signed URL creation fails
      signedUrls = null;
    }

    const imagesWithSignedUrls = images.map((img) => {
      const match = signedUrls?.find((s) => s.path === img.storage_path);
      const url = match?.signedUrl;
      return {
        ...img,
        signed_url: url && typeof url === "string" && url.trim() !== "" ? url : null,
      };
    });

    return NextResponse.json({ images: imagesWithSignedUrls });
  } catch (err) {
    console.error("GET images route error:", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

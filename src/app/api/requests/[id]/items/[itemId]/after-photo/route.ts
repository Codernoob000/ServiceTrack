import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getServiceRoleClient } from "@/lib/supabase/admin";
import { SERVICE_IMAGES_BUCKET } from "@/lib/constants";
import sharp from "sharp";

interface RouteParams {
  params: Promise<{ id: string; itemId: string }>;
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
 * POST /api/requests/[id]/items/[itemId]/after-photo
 * Uploads proof-of-repair after photo for an approved repair item.
 * - Authenticated assigned mechanic only
 * - Reuses Phase 2 validation & sanitization pipeline
 * - Stored at requests/{id}/after/{uuid}.jpg in SERVICE_IMAGES_BUCKET
 * - Calls atomic SQL attach_after_photo RPC
 * - Deletes newly uploaded file if RPC fails
 * - Deletes previous after photo if replacement succeeds
 * - Maps error codes: P0010 -> 404, P0011 -> 403, P0012 -> 409, P0013 -> 404, P0014 -> 400, P0015 -> 409, P0016 -> 409
 * - Returns only item_id, 10-minute signed URL, counts, and status (no raw paths or raw DB row)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  let storagePath: string | null = null;
  const admin = getServiceRoleClient();

  try {
    const { id, itemId } = await params;

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
        { error: "Forbidden: Only mechanics can upload repair proof photos." },
        { status: 403 }
      );
    }

    // 3. Parse multipart/form-data
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid form data." },
        { status: 400 }
      );
    }

    const file = formData.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json(
        { error: "Missing file: an image file must be provided." },
        { status: 400 }
      );
    }

    // 4. Check parsed file size from Blob
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: "Payload too large. File size exceeds 4 MB limit." },
        { status: 413 }
      );
    }

    // 5. Read bytes and validate actual buffer length & magic bytes
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

    // 6. Server-side re-encoding via sharp to strip EXIF/GPS, auto-rotate, and normalize to JPEG
    let processedBuffer: Buffer;
    try {
      processedBuffer = await sharp(rawBuffer)
        .rotate()
        .jpeg({ quality: 85, mozjpeg: false })
        .toBuffer();
    } catch (sharpError) {
      console.error("Image re-encoding error:", sharpError);
      return NextResponse.json(
        { error: "Corrupted or unreadable image file." },
        { status: 400 }
      );
    }

    // 7. Generate random storage path: requests/{id}/after/{uuid}.jpg
    const randomFileName = `${crypto.randomUUID()}.jpg`;
    storagePath = `requests/${id}/after/${randomFileName}`;

    // 8. Upload to Supabase Storage in SERVICE_IMAGES_BUCKET
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

    // 9. Call attach_after_photo RPC
    const { data: rpcData, error: rpcError } = await admin.rpc("attach_after_photo", {
      p_request_id: id,
      p_item_id: itemId,
      p_caller_id: user.id,
      p_path: storagePath,
    });

    if (rpcError) {
      // If function fails, delete the uploaded file immediately
      if (storagePath) {
        await admin.storage.from(SERVICE_IMAGES_BUCKET).remove([storagePath]);
      }

      const code = rpcError.code;

      if (code === "P0010") {
        return NextResponse.json({ error: "Request not found." }, { status: 404 });
      }
      if (code === "P0011") {
        return NextResponse.json(
          { error: "Forbidden: Only the assigned mechanic can upload repair proof photos." },
          { status: 403 }
        );
      }
      if (code === "P0012") {
        return NextResponse.json(
          { error: "Conflict: Request is not in repairing status." },
          { status: 409 }
        );
      }
      if (code === "P0013") {
        // Generic message for both "item not found" and "item not approved"
        return NextResponse.json(
          { error: "Repair item not found." },
          { status: 404 }
        );
      }
      if (code === "P0014") {
        return NextResponse.json(
          { error: "Bad Request: Invalid storage path." },
          { status: 400 }
        );
      }
      if (code === "P0015") {
        return NextResponse.json(
          { error: "Conflict: Cannot modify after photo when request is not repairing." },
          { status: 409 }
        );
      }
      if (code === "P0016") {
        return NextResponse.json(
          { error: "Conflict: Cannot attach photo to non-approved repair item." },
          { status: 409 }
        );
      }

      console.error("attach_after_photo RPC error:", rpcError);
      return NextResponse.json({ error: "Failed to attach after photo." }, { status: 500 });
    }

    // 10. If a replacement succeeds, delete the old file
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldPath = (rpcData as any)?.old_after_photo_url;
    if (oldPath && typeof oldPath === "string" && oldPath !== storagePath) {
      const { error: removeOldError } = await admin.storage
        .from(SERVICE_IMAGES_BUCKET)
        .remove([oldPath]);
      if (removeOldError) {
        console.error("Failed to delete previous after photo from storage:", removeOldError);
      }
    }

    // 11. Generate fresh 10-minute signed URL
    const { data: signedData } = await admin.storage
      .from(SERVICE_IMAGES_BUCKET)
      .createSignedUrl(storagePath, 600);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpcRes = rpcData as any;

    // Do NOT return raw storage paths or the raw item row; return only item_id, signed url, counts and status
    return NextResponse.json({
      success: true,
      item_id: itemId,
      after_photo_url: signedData?.signedUrl || null,
      signed_url: signedData?.signedUrl || null,
      proof_count: rpcRes?.proof_count ?? rpcRes?.approved_with_proof_count ?? 0,
      approved_with_proof_count: rpcRes?.approved_with_proof_count ?? rpcRes?.proof_count ?? 0,
      total_approved: rpcRes?.total_approved ?? rpcRes?.total_approved_count ?? 0,
      total_approved_count: rpcRes?.total_approved_count ?? rpcRes?.total_approved ?? 0,
      status: rpcRes?.status ?? rpcRes?.request_status ?? "repairing",
    });
  } catch (err) {
    console.error("After-photo upload route error:", err);
    if (storagePath) {
      try {
        await admin.storage.from(SERVICE_IMAGES_BUCKET).remove([storagePath]);
      } catch (cleanupErr) {
        console.error("Failed to clean up storage path on error:", cleanupErr);
      }
    }
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

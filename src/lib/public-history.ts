import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/admin";
import { SERVICE_IMAGES_BUCKET } from "@/lib/constants";

const tokenSchema = z.string().uuid();

export interface PublicRepairItem {
  date: string;
  part_name: string;
  before_url: string | null;
  after_url: string | null;
}

export interface PublicVehicleHistory {
  brand: string;
  model: string;
  year: number;
  masked_plate: string;
  repairs: PublicRepairItem[];
}

export async function fetchPublicVehicleHistory(token: string): Promise<PublicVehicleHistory | null> {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) {
    return null;
  }

  const admin = getServiceRoleClient();
  const { data, error } = await admin.rpc("public_vehicle_history", {
    p_token: parsed.data,
  });

  if (error || !data) {
    return null;
  }

  const rawRepairs = Array.isArray(data.repairs) ? data.repairs : [];
  const repairs: PublicRepairItem[] = await Promise.all(
    rawRepairs.map(async (r: any) => {
      let beforeSignedUrl: string | null = null;
      let afterSignedUrl: string | null = null;

      try {
        if (r.before_image_path) {
          const { data: bData } = await admin.storage
            .from(SERVICE_IMAGES_BUCKET)
            .createSignedUrl(r.before_image_path, 600);
          if (bData?.signedUrl && bData.signedUrl.trim() !== "") {
            beforeSignedUrl = bData.signedUrl;
          }
        }
      } catch {
        // Do not fail the whole response
      }

      try {
        if (r.after_image_path) {
          const { data: aData } = await admin.storage
            .from(SERVICE_IMAGES_BUCKET)
            .createSignedUrl(r.after_image_path, 600);
          if (aData?.signedUrl && aData.signedUrl.trim() !== "") {
            afterSignedUrl = aData.signedUrl;
          }
        }
      } catch {
        // Do not fail the whole response
      }

      return {
        date: r.completed_at || "",
        part_name: r.part_name || "Repair Item",
        before_url: beforeSignedUrl,
        after_url: afterSignedUrl,
      };
    })
  );

  return {
    brand: data.brand,
    model: data.model,
    year: data.year,
    masked_plate: data.masked_plate,
    repairs,
  };
}

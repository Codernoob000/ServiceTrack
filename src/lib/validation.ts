import { z } from "zod";

export const registerSchema = z
  .object({
    email: z.string().trim().email("Invalid email address").max(255),
    password: z.string().min(8, "Password must be at least 8 characters").max(100),
    name: z.string().trim().min(1, "Name is required").max(100),
    phone: z.string().trim().max(20).optional().nullable(),
    role: z.enum(["customer", "mechanic"]),
    inviteCode: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.role === "mechanic") {
        return !!data.inviteCode && data.inviteCode.trim().length > 0;
      }
      return true;
    },
    {
      message: "Mechanic invite code is required",
      path: ["inviteCode"],
    }
  );

export const loginSchema = z.object({
  email: z.string().trim().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100).optional(),
  phone: z.string().trim().max(20).optional().nullable(),
});

export const vehicleCreateSchema = z.object({
  plate: z
    .string()
    .trim()
    .min(2, "Plate must be at least 2 characters")
    .max(15, "Plate cannot exceed 15 characters")
    .regex(/^[A-Za-z0-9\- ]+$/, "Plate contains invalid characters"),
  brand: z.string().trim().min(1, "Brand is required").max(50),
  model: z.string().trim().min(1, "Model is required").max(50),
  year: z.coerce.number().int().min(1900, "Year must be at least 1900").max(2100, "Invalid year"),
});

export const vehicleUpdateSchema = z.object({
  plate: z
    .string()
    .trim()
    .min(2, "Plate must be at least 2 characters")
    .max(15, "Plate cannot exceed 15 characters")
    .regex(/^[A-Za-z0-9\- ]+$/, "Plate contains invalid characters")
    .optional(),
  brand: z.string().trim().min(1, "Brand is required").max(50).optional(),
  model: z.string().trim().min(1, "Model is required").max(50).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  is_active: z.boolean().optional(),
});

export const requestCreateSchema = z.object({
  vehicle_id: z.string().uuid("Invalid vehicle ID"),
  service_type: z.enum([
    "oil_change",
    "brake_service",
    "tire_rotation",
    "full_inspection",
    "engine_diagnostics",
    "other",
  ]),
  complaint: z.string().trim().min(5, "Complaint must be at least 5 characters").max(2000),
  preferred_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)"),
});

export const requestTransitionSchema = z.object({
  action: z.enum(["cancel", "release", "start_inspection", "complete", "submit_report"]),
});

export const viewAngleSchema = z.enum(["front", "rear", "left", "right", "other"]);

export const pinCreateSchema = z.object({
  image_id: z.string().uuid("Invalid image ID"),
  x: z.number().min(0, "x must be >= 0").max(1, "x must be <= 1"),
  y: z.number().min(0, "y must be >= 0").max(1, "y must be <= 1"),
  part_name: z.string().trim().min(1, "Part name is required").max(100, "Part name max 100 characters"),
  severity: z.enum(["low", "medium", "high", "critical"]),
  notes: z.string().max(1000, "Notes max 1000 characters").optional().nullable(),
  description: z.string().trim().min(1, "Description is required").max(500, "Description max 500 characters"),
  estimate: z.number().int("Estimate must be a whole number").min(0, "Estimate must be >= 0").max(1000000, "Estimate max 1,000,000"),
});

export const pinUpdateSchema = z.strictObject({
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  part_name: z.string().trim().min(1).max(100).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  notes: z.string().max(1000).optional().nullable(),
  description: z.string().trim().min(1).max(500).optional(),
  estimate: z.number().int().min(0).max(1000000).optional(),
});

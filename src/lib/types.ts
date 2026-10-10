export type UserRole = "customer" | "mechanic";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  created_at: string;
}

export interface Vehicle {
  id: string;
  user_id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
  is_active: boolean;
  public_token: string;
  created_at: string;
}

export type RequestStatus =
  | "booked"
  | "inspecting"
  | "awaiting_approval"
  | "repairing"
  | "done"
  | "cancelled";

export type ServiceType =
  | "oil_change"
  | "brake_service"
  | "tire_rotation"
  | "full_inspection"
  | "engine_diagnostics"
  | "other";

export interface ServiceRequest {
  id: string;
  vehicle_id: string;
  mechanic_id: string | null;
  service_type: ServiceType;
  complaint: string;
  preferred_date: string;
  status: RequestStatus;
  created_at: string;
  // Joined relation fields
  vehicle?: Vehicle;
  mechanic?: UserProfile | null;
}

export type ViewAngle = "front" | "rear" | "left" | "right" | "other";

export interface ServiceImage {
  id: string;
  request_id: string;
  storage_path: string;
  view_angle: ViewAngle;
  created_at: string;
  /** Populated by API responses; not stored in the database. */
  signed_url?: string;
}

export type Severity = "low" | "medium" | "high" | "critical";

export interface Pin {
  id: string;
  image_id: string;
  x: number;
  y: number;
  part_name: string;
  severity: Severity;
  notes: string | null;
  created_at: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface RepairItem {
  id: string;
  pin_id: string;
  description: string;
  estimate: number;
  approval_status: ApprovalStatus;
  after_photo_url: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface PinWithItem extends Pin {
  repair_item: RepairItem;
}

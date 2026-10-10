import { ServiceType, RequestStatus, Severity } from "./types";

export const SERVICE_TYPES: { value: ServiceType; label: string; description: string }[] = [
  { value: "oil_change", label: "Oil & Filter Change", description: "Engine oil change with filter replacement." },
  { value: "brake_service", label: "Brake Service", description: "Inspection, pad replacement, or rotor resurfacing." },
  { value: "tire_rotation", label: "Tire Rotation & Balance", description: "Even tread wear check and balancing." },
  { value: "full_inspection", label: "Multi-Point Inspection", description: "Comprehensive bumper-to-bumper vehicle inspection." },
  { value: "engine_diagnostics", label: "Engine Diagnostics", description: "Check engine light scan and diagnosis." },
  { value: "other", label: "Other / Custom Work", description: "General repair or custom maintenance request." },
];

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  oil_change: "Oil & Filter Change",
  brake_service: "Brake Service",
  tire_rotation: "Tire Rotation & Balance",
  full_inspection: "Multi-Point Inspection",
  engine_diagnostics: "Engine Diagnostics",
  other: "Other Service",
};

export interface StepperStep {
  key: RequestStatus;
  label: string;
  description: string;
}

export const STATUS_STEPS: StepperStep[] = [
  { key: "booked", label: "Booked", description: "Service requested" },
  { key: "inspecting", label: "Inspecting", description: "Mechanic assessing" },
  { key: "awaiting_approval", label: "Awaiting you", description: "Review required" },
  { key: "repairing", label: "Repairing", description: "Work in progress" },
  { key: "done", label: "Done", description: "Service complete" },
];

export const STATUS_ORDER: Record<RequestStatus, number> = {
  booked: 0,
  inspecting: 1,
  awaiting_approval: 2,
  repairing: 3,
  done: 4,
  cancelled: -1,
};

export const SEVERITY_CONFIG: Record<
  Severity,
  { label: string; bgClass: string; textClass: string; borderClass: string }
> = {
  low: {
    label: "Low",
    bgClass: "bg-emerald-50",
    textClass: "text-emerald-700",
    borderClass: "border-emerald-300",
  },
  medium: {
    label: "Medium",
    bgClass: "bg-amber-50",
    textClass: "text-amber-700",
    borderClass: "border-amber-300",
  },
  high: {
    label: "High",
    bgClass: "bg-orange-50",
    textClass: "text-orange-700",
    borderClass: "border-orange-300",
  },
  critical: {
    label: "Critical",
    bgClass: "bg-red-50",
    textClass: "text-red-700",
    borderClass: "border-red-300",
  },
};

export const SERVICE_IMAGES_BUCKET = "service-images";

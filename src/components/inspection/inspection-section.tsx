"use client";

import * as React from "react";
import Link from "next/link";
import { ServiceImage, PinWithItem, ViewAngle, Severity } from "@/lib/types";
import { compressImage } from "@/lib/image-compress";
import { authFetch } from "@/lib/auth-fetch";
import { InspectionCanvas } from "./inspection-canvas";
import { PinBottomSheet } from "./pin-bottom-sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Camera,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Plus,
  FileText,
} from "lucide-react";

const ANGLES: { value: ViewAngle; label: string }[] = [
  { value: "front", label: "Front" },
  { value: "rear", label: "Rear" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "other", label: "Other" },
];

const SEVERITY_BADGES: Record<
  Severity,
  { label: string; badgeClass: string; dotClass: string }
> = {
  low: {
    label: "Low",
    badgeClass: "bg-emerald-50 text-emerald-800 border-emerald-200",
    dotClass: "bg-emerald-600",
  },
  medium: {
    label: "Medium",
    badgeClass: "bg-amber-50 text-amber-800 border-amber-200",
    dotClass: "bg-amber-600",
  },
  high: {
    label: "High",
    badgeClass: "bg-red-50 text-red-800 border-red-200",
    dotClass: "bg-red-600",
  },
  critical: {
    label: "Critical",
    badgeClass: "bg-rose-50 text-rose-900 border-rose-200",
    dotClass: "bg-rose-800",
  },
};

interface InspectionSectionProps {
  requestId: string;
  status: string;
  userRole: "customer" | "mechanic";
  isAssignedMechanic: boolean;
  onRequestUpdated: () => void;
  onImagesCountChange?: (count: number) => void;
}

export function InspectionSection({
  requestId,
  status,
  userRole,
  isAssignedMechanic,
  onRequestUpdated,
  onImagesCountChange,
}: InspectionSectionProps) {
  const [activeAngle, setActiveAngle] = React.useState<ViewAngle>("front");
  const [images, setImages] = React.useState<ServiceImage[]>([]);
  const [pins, setPins] = React.useState<PinWithItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Active selected image ID within the active angle tab
  const [selectedImageId, setSelectedImageId] = React.useState<string | null>(null);

  // Upload state
  const [isUploading, setIsUploading] = React.useState(false);
  const [uploadStatusText, setUploadStatusText] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Pin bottom sheet state
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [editingPin, setEditingPin] = React.useState<PinWithItem | null>(null);
  const [draftCoords, setDraftCoords] = React.useState<{ x: number; y: number } | null>(null);

  // Delete image state
  const [showConfirmDeleteImage, setShowConfirmDeleteImage] = React.useState(false);
  const [isDeletingImage, setIsDeletingImage] = React.useState(false);

  // Submit report dialog state
  const [showConfirmSubmit, setShowConfirmSubmit] = React.useState(false);
  const [isSubmittingReport, setIsSubmittingReport] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Customer decisions state (Phase 3)
  const [decisions, setDecisions] = React.useState<Record<string, "approved" | "rejected">>({});
  const [showConfirmDecisions, setShowConfirmDecisions] = React.useState(false);
  const [isSubmittingDecisions, setIsSubmittingDecisions] = React.useState(false);
  const [decisionsError, setDecisionsError] = React.useState<string | null>(null);

  const isCustomer = userRole === "customer";
  const isMechanic = userRole === "mechanic";
  const isInspecting = status === "inspecting";
  const isSubmittedOrBeyond = ["awaiting_approval", "repairing", "done"].includes(status);

  // 1. Fetch images & pins
  const loadInspectionData = React.useCallback(async () => {
    // Customers cannot access images/pins before submission (403 read gate)
    if (isCustomer && !isSubmittedOrBeyond) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [imagesRes, pinsRes] = await Promise.all([
        authFetch(`/api/requests/${requestId}/images`),
        authFetch(`/api/requests/${requestId}/pins`),
      ]);

      if (!imagesRes.ok) {
        if (imagesRes.status === 403) {
          setError("You do not have access to inspection data.");
          setLoading(false);
          return;
        }
        throw new Error("Failed to load inspection images.");
      }

      if (!pinsRes.ok) {
        throw new Error("Failed to load defect pins.");
      }

      const imagesData = await imagesRes.json();
      const pinsData = await pinsRes.json();

      const loadedImages: ServiceImage[] = imagesData.images || [];
      const loadedPins: PinWithItem[] = pinsData.pins || [];

      setImages(loadedImages);
      setPins(loadedPins);
      if (onImagesCountChange) {
        onImagesCountChange(loadedImages.length);
      }

      // Pre-populate decisions from existing approval_status
      const existingDecisions: Record<string, "approved" | "rejected"> = {};
      loadedPins.forEach((p) => {
        if (
          p.repair_item?.id &&
          (p.repair_item.approval_status === "approved" ||
            p.repair_item.approval_status === "rejected")
        ) {
          existingDecisions[p.repair_item.id] = p.repair_item.approval_status as "approved" | "rejected";
        }
      });
      setDecisions((prev) => ({ ...existingDecisions, ...prev }));

      // Default selected image to first image in active angle or first available
      const matchingImg = loadedImages.find((img) => img.view_angle === activeAngle);
      if (matchingImg) {
        setSelectedImageId(matchingImg.id);
      } else if (loadedImages.length > 0) {
        setSelectedImageId(loadedImages[0].id);
      } else {
        setSelectedImageId(null);
      }
    } catch (err: unknown) {
      console.error("Load inspection data error:", err);
      setError("Unable to load inspection data.");
    } finally {
      setLoading(false);
    }
  }, [requestId, isCustomer, isSubmittedOrBeyond, activeAngle, onImagesCountChange]);

  React.useEffect(() => {
    loadInspectionData();
  }, [loadInspectionData]);

  // Map each pin to a persistent 1-based index (sorted by created_at)
  const pinNumberMap = React.useMemo(() => {
    const map = new Map<string, number>();
    pins.forEach((p, index) => {
      map.set(p.id, index + 1);
    });
    return map;
  }, [pins]);

  // Filter images for active angle tab
  const imagesForActiveAngle = React.useMemo(() => {
    return images.filter((img) => img.view_angle === activeAngle);
  }, [images, activeAngle]);

  // Current active image
  const currentImage = React.useMemo(() => {
    return images.find((img) => img.id === selectedImageId) || imagesForActiveAngle[0] || null;
  }, [images, selectedImageId, imagesForActiveAngle]);

  // Pins for currently active image
  const pinsForCurrentImage = React.useMemo(() => {
    if (!currentImage) return [];
    return pins.filter((p) => p.image_id === currentImage.id);
  }, [pins, currentImage]);

  // Total estimate in Rupees
  const totalEstimate = React.useMemo(() => {
    return pins.reduce((sum, p) => sum + (p.repair_item?.estimate || 0), 0);
  }, [pins]);

  // Valid repair items for decisions
  const repairItems = React.useMemo(() => {
    return pins
      .map((p) => p.repair_item)
      .filter((item): item is NonNullable<typeof item> => Boolean(item && item.id));
  }, [pins]);

  const decidedCount = React.useMemo(() => {
    return repairItems.filter((item) => Boolean(decisions[item.id])).length;
  }, [repairItems, decisions]);

  const allDecided = repairItems.length > 0 && decidedCount === repairItems.length;

  const liveApprovedTotal = React.useMemo(() => {
    return repairItems
      .filter((item) => decisions[item.id] === "approved")
      .reduce((sum, item) => sum + (item.estimate || 0), 0);
  }, [repairItems, decisions]);

  const approvedCount = React.useMemo(() => {
    return repairItems.filter((item) => decisions[item.id] === "approved").length;
  }, [repairItems, decisions]);

  const rejectedCount = React.useMemo(() => {
    return repairItems.filter((item) => decisions[item.id] === "rejected").length;
  }, [repairItems, decisions]);

  const finalizedApprovedTotal = React.useMemo(() => {
    return repairItems
      .filter((item) => item.approval_status === "approved")
      .reduce((sum, item) => sum + (item.estimate || 0), 0);
  }, [repairItems]);

  const finalizedApprovedCount = React.useMemo(() => {
    return repairItems.filter((item) => item.approval_status === "approved").length;
  }, [repairItems]);

  // When changing tab, adjust selected image to one matching the tab
  function handleSelectAngle(angle: ViewAngle) {
    setActiveAngle(angle);
    const matching = images.find((img) => img.view_angle === angle);
    if (matching) {
      setSelectedImageId(matching.id);
    } else {
      setSelectedImageId(null);
    }
  }

  // Handle Photo Upload with Client-Side Compression
  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (images.length >= 10) {
      setError("Maximum limit of 10 photos reached.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setIsUploading(true);
    setUploadStatusText("Compressing photo (1600px max)...");
    setError(null);

    try {
      // 1. Client-side downscale to ~1600px JPEG
      const compressedBlob = await compressImage(file, 1600, 0.85);

      setUploadStatusText("Uploading to server...");

      // 2. Submit multipart form data
      const formData = new FormData();
      formData.append("file", compressedBlob, `${activeAngle}_photo.jpg`);
      formData.append("view_angle", activeAngle);

      const res = await authFetch(`/api/requests/${requestId}/images`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to upload photo.");
      }

      // 3. Update local state
      const newImg = data.image as ServiceImage;
      const updated = [...images, newImg];
      setImages(updated);
      setSelectedImageId(newImg.id);
      if (onImagesCountChange) {
        onImagesCountChange(updated.length);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error uploading photo.";
      setError(msg);
    } finally {
      setIsUploading(false);
      setUploadStatusText(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Handle Photo Delete
  async function handleDeleteImageConfirm() {
    if (!currentImage) return;
    setIsDeletingImage(true);
    setError(null);
    try {
      const res = await authFetch(`/api/requests/${requestId}/images/${currentImage.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete image.");
      }

      // Remove image and associated pins
      const remainingImages = images.filter((img) => img.id !== currentImage.id);
      const remainingPins = pins.filter((p) => p.image_id !== currentImage.id);
      setImages(remainingImages);
      setPins(remainingPins);
      if (onImagesCountChange) {
        onImagesCountChange(remainingImages.length);
      }

      const nextMatching = remainingImages.find((img) => img.view_angle === activeAngle);
      setSelectedImageId(nextMatching ? nextMatching.id : null);
      setShowConfirmDeleteImage(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete photo.";
      setError(msg);
    } finally {
      setIsDeletingImage(false);
    }
  }

  // Handle Pin Drop
  function handleDropPin(coords: { x: number; y: number }) {
    if (!isInspecting || !isAssignedMechanic) return;
    setEditingPin(null);
    setDraftCoords(coords);
    setSheetOpen(true);
  }

  // Handle Pin Click
  function handlePinClick(pin: PinWithItem) {
    if (isInspecting && isAssignedMechanic) {
      setEditingPin(pin);
      setDraftCoords({ x: pin.x, y: pin.y });
      setSheetOpen(true);
    }
  }

  // Handle Save Pin (Create or Update)
  async function handleSavePin(data: {
    part_name: string;
    severity: Severity;
    notes?: string;
    description: string;
    estimate: number;
  }) {
    if (!currentImage) return;

    if (editingPin) {
      // PATCH existing pin
      const res = await authFetch(`/api/requests/${requestId}/pins/${editingPin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const resData = await res.json();
      if (!res.ok) {
        throw new Error(resData.error || "Failed to update defect pin.");
      }

      setPins((prev) =>
        prev.map((p) => (p.id === editingPin.id ? (resData.pin as PinWithItem) : p))
      );
    } else if (draftCoords) {
      // POST new pin
      const res = await authFetch(`/api/requests/${requestId}/pins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_id: currentImage.id,
          x: draftCoords.x,
          y: draftCoords.y,
          ...data,
        }),
      });

      const resData = await res.json();
      if (!res.ok) {
        throw new Error(resData.error || "Failed to create defect pin.");
      }

      const rawPin = resData.pin;
      const pinId = rawPin.id || rawPin.pin_id;
      const normalizedPin: PinWithItem = {
        ...rawPin,
        id: pinId,
        repair_item: rawPin.repair_item || {
          id: rawPin.item_id || "",
          pin_id: pinId,
          description: data.description,
          estimate: data.estimate,
          approval_status: "pending",
          after_photo_url: null,
          completed_at: null,
          created_at: new Date().toISOString(),
        },
      };

      setPins((prev) => [...prev, normalizedPin]);
    }
  }

  // Handle Delete Pin
  async function handleDeletePin(pinId: string) {
    const res = await authFetch(`/api/requests/${requestId}/pins/${pinId}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to delete defect pin.");
    }

    setPins((prev) => prev.filter((p) => p.id !== pinId));
  }

  // Handle Submit Report
  async function handleSubmitReportConfirm() {
    setIsSubmittingReport(true);
    setSubmitError(null);
    try {
      const res = await authFetch(`/api/requests/${requestId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit_report" }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to submit inspection report.");
      }

      setShowConfirmSubmit(false);
      onRequestUpdated();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error submitting report.";
      setSubmitError(msg);
    } finally {
      setIsSubmittingReport(false);
    }
  }

  // Handle Customer Submit Decisions (Phase 3)
  async function handleSubmitDecisionsConfirm() {
    setIsSubmittingDecisions(true);
    setDecisionsError(null);
    try {
      const payload = {
        decisions: repairItems.map((item) => ({
          item_id: item.id,
          decision: decisions[item.id],
        })),
      };

      const res = await authFetch(`/api/requests/${requestId}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to submit decisions.");
      }

      setShowConfirmDecisions(false);
      onRequestUpdated();
      await loadInspectionData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error submitting decisions.";
      setDecisionsError(msg);
    } finally {
      setIsSubmittingDecisions(false);
    }
  }

  // CUSTOMER VIEW: Before submit (status is 'booked' or 'inspecting')
  if (isCustomer && !isSubmittedOrBeyond) {
    return (
      <div className="p-6 rounded-xl border border-gray-200 bg-white text-center space-y-3">
        <div className="w-10 h-10 rounded-full bg-blue-50 text-[#2563eb] flex items-center justify-center mx-auto">
          <Clock className="w-5 h-5" />
        </div>
        <h2 className="text-sm font-bold text-gray-900">Inspection in progress.</h2>
        <p className="text-xs text-gray-600 max-w-md mx-auto leading-relaxed">
          The assigned technician is currently reviewing the vehicle and documenting inspection
          photos with defect pin findings. The full report with estimates will be available here once
          submitted for your authorization.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8 rounded-xl border border-gray-200 bg-white flex flex-col items-center justify-center space-y-2">
        <Loader2 className="w-6 h-6 animate-spin text-[#2563eb]" />
        <span className="text-xs text-gray-500">Loading inspection findings...</span>
      </div>
    );
  }

  const isReadOnly = isSubmittedOrBeyond || !isAssignedMechanic;

  return (
    <div className="space-y-6">
      {/* Top Banner / Heading with Submitted Status Badge */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-gray-900">Vehicle Visual Inspection</h2>
          <p className="text-xs text-gray-500">
            {isReadOnly
              ? "Inspection findings and estimated repair items."
              : "Upload photos from each angle and drop defect pins with repair estimates."}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isSubmittedOrBeyond && (
            <Badge variant="active" className="bg-emerald-50 text-emerald-800 border-emerald-300">
              Submitted
            </Badge>
          )}
          {!isReadOnly && (
            <span className="text-xs font-semibold px-2.5 py-1 rounded-md bg-gray-100 text-gray-700 border border-gray-200">
              {images.length} / 10 photos
            </span>
          )}
        </div>
      </div>

      {error && (
        <div
          className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-start gap-2"
          role="alert"
        >
          <AlertCircle className="w-4 h-4 shrink-0 text-red-600 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Angle Tabs */}
      <div className="space-y-3">
        <div
          className="grid grid-cols-5 gap-1.5 p-1 bg-gray-100 rounded-lg border border-gray-200"
          role="tablist"
        >
          {ANGLES.map((angle) => {
            const isSelected = activeAngle === angle.value;
            const countForAngle = images.filter((img) => img.view_angle === angle.value).length;

            return (
              <button
                key={angle.value}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => handleSelectAngle(angle.value)}
                className={`touch-target flex flex-col items-center justify-center py-2 px-1 rounded-md text-xs font-semibold transition-all focus-visible:outline-2 focus-visible:outline-[#2563eb] ${
                  isSelected
                    ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                }`}
              >
                <span>{angle.label}</span>
                {countForAngle > 0 && (
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full mt-0.5 ${
                      isSelected
                        ? "bg-[#2563eb] text-white"
                        : "bg-gray-200 text-gray-700"
                    }`}
                  >
                    {countForAngle}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Thumbnail Selector if multiple photos exist for this angle */}
        {imagesForActiveAngle.length > 1 && (
          <div className="flex items-center gap-2 overflow-x-auto py-1">
            <span className="text-xs text-gray-500 font-medium">Angle views:</span>
            {imagesForActiveAngle.map((img, idx) => {
              const isSelected = img.id === currentImage?.id;
              return (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => setSelectedImageId(img.id)}
                  className={`touch-target px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                    isSelected
                      ? "bg-[#2563eb] text-white border-[#2563eb]"
                      : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  View #{idx + 1}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Main Interactive Canvas or Upload Box */}
      <div className="space-y-3">
        {currentImage?.signed_url ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span className="capitalize font-semibold text-gray-800">
                {activeAngle} Angle Photo
              </span>

              {!isReadOnly && (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowConfirmDeleteImage(true)}
                    className="touch-target text-red-600 hover:text-red-700 hover:bg-red-50 text-xs gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Photo</span>
                  </Button>
                </div>
              )}
            </div>

            <InspectionCanvas
              imageUrl={currentImage.signed_url}
              pins={pinsForCurrentImage}
              pinNumberMap={pinNumberMap}
              readOnly={isReadOnly}
              onDropPin={handleDropPin}
              onPinClick={handlePinClick}
            />
          </div>
        ) : (
          /* Empty state for this angle */
          <div className="p-8 rounded-xl border border-dashed border-gray-300 bg-white text-center flex flex-col items-center justify-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-gray-500">
              <Camera className="w-6 h-6" />
            </div>

            <div>
              <p className="text-xs font-bold text-gray-900">
                No photo uploaded for {activeAngle} view
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {isReadOnly
                  ? "No defect documentation was captured for this angle."
                  : "Upload a high-resolution photo from this angle to identify defects."}
              </p>
            </div>

            {!isReadOnly && (
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  onChange={handleFileSelected}
                  className="hidden"
                  id={`upload-photo-${activeAngle}`}
                  disabled={isUploading || images.length >= 10}
                />
                <Button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading || images.length >= 10}
                  className="touch-target bg-[#2563eb] hover:bg-blue-700 text-white text-xs font-semibold gap-1.5"
                >
                  {isUploading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-white" />
                      <span>{uploadStatusText || "Uploading..."}</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" />
                      <span>Add {activeAngle} Photo</span>
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Extra Upload Action when photo is already present on this tab */}
        {currentImage && !isReadOnly && images.length < 10 && (
          <div className="flex items-center justify-end">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png"
              onChange={handleFileSelected}
              className="hidden"
              id="upload-another-photo"
              disabled={isUploading}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="touch-target text-xs gap-1.5"
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-600" />
                  <span>{uploadStatusText || "Processing..."}</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add another photo ({images.length}/10)</span>
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {/* List of Repair Items with Estimates */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-gray-900">
            Defect Pins & Estimated Repairs ({pins.length})
          </h3>
          <span className="text-xs text-gray-500">
            Total Estimate:{" "}
            <strong className="text-gray-900 font-semibold">
              ₹{totalEstimate.toLocaleString("en-IN")}
            </strong>
          </span>
        </div>

        {pins.length === 0 ? (
          <div className="p-4 rounded-lg border border-gray-200 bg-gray-50 text-center text-xs text-gray-500">
            {isReadOnly
              ? "No repair items reported."
              : "No defect pins added yet. Tap on any photo to drop a pin."}
          </div>
        ) : (
          <div className="space-y-2.5">
            {pins.map((pin) => {
              const num = pinNumberMap.get(pin.id) || 1;
              const sev = SEVERITY_BADGES[pin.severity] || SEVERITY_BADGES.medium;
              const imgAngle =
                images.find((i) => i.id === pin.image_id)?.view_angle || "view";

              const pinId = pin.id || (pin as unknown as { pin_id?: string }).pin_id;
              return (
                <div
                  key={pinId}
                  className="p-3.5 rounded-lg border border-gray-200 bg-white flex flex-col sm:flex-row sm:items-start justify-between gap-3"
                >
                  <div className="space-y-1.5 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full bg-[#2563eb] text-white text-xs font-bold flex items-center justify-center shrink-0">
                        {num}
                      </span>
                      <h4 className="text-xs font-bold text-gray-900">{pin.part_name}</h4>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border flex items-center gap-1 ${sev.badgeClass}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${sev.dotClass}`} />
                        <span>{sev.label}</span>
                      </span>
                      <span className="text-[11px] text-gray-500 capitalize">
                        ({imgAngle})
                      </span>
                    </div>

                    <p className="text-xs text-gray-800 leading-relaxed pl-8">
                      {pin.repair_item?.description}
                    </p>

                    {pin.notes && (
                      <p className="text-[11px] text-gray-500 italic pl-8">
                        Notes: {pin.notes}
                      </p>
                    )}
                  </div>

                  <div className="flex sm:flex-col items-center sm:items-end justify-between pl-8 sm:pl-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-100 gap-2">
                    <div className="text-left sm:text-right">
                      <span className="text-[11px] text-gray-500 block">Estimate</span>
                      <span className="text-sm font-bold text-gray-900">
                        ₹{(pin.repair_item?.estimate || 0).toLocaleString("en-IN")}
                      </span>
                    </div>

                    {!isReadOnly ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handlePinClick(pin)}
                        className="touch-target text-xs text-[#2563eb] hover:bg-blue-50"
                      >
                        Edit
                      </Button>
                    ) : isCustomer && status === "awaiting_approval" && pin.repair_item ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setDecisions((prev) => ({ ...prev, [pin.repair_item!.id]: "approved" }))
                          }
                          className={`touch-target px-3 py-1.5 rounded-lg text-xs font-semibold min-h-[44px] min-w-[76px] transition-all flex items-center justify-center gap-1 ${
                            decisions[pin.repair_item.id] === "approved"
                              ? "bg-emerald-600 text-white shadow-sm"
                              : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
                          }`}
                        >
                          {decisions[pin.repair_item.id] === "approved" ? "Approved" : "Approve"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDecisions((prev) => ({ ...prev, [pin.repair_item!.id]: "rejected" }))
                          }
                          className={`touch-target px-3 py-1.5 rounded-lg text-xs font-semibold min-h-[44px] min-w-[76px] transition-all flex items-center justify-center gap-1 ${
                            decisions[pin.repair_item.id] === "rejected"
                              ? "bg-gray-800 text-white shadow-sm"
                              : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
                          }`}
                        >
                          {decisions[pin.repair_item.id] === "rejected" ? "Rejected" : "Reject"}
                        </button>
                      </div>
                    ) : pin.repair_item ? (
                      <div className="flex items-center pt-1">
                        {pin.repair_item.approval_status === "approved" ? (
                          <span className="text-xs font-semibold px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-300 inline-block">
                            Approved
                          </span>
                        ) : pin.repair_item.approval_status === "rejected" ? (
                          <span className="text-xs font-semibold px-2.5 py-1 rounded-md bg-gray-100 text-gray-700 border border-gray-300 inline-block">
                            Rejected
                          </span>
                        ) : (
                          <span className="text-xs font-semibold px-2.5 py-1 rounded-md bg-amber-50 text-amber-800 border border-amber-300 inline-block">
                            Pending
                          </span>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Case 1: Status is inspecting (Mechanic only summary bar) */}
      {!isReadOnly && (
        <div className="p-4 rounded-xl border border-gray-200 bg-gray-50 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="grid grid-cols-3 gap-6 w-full sm:w-auto text-left">
            <div>
              <span className="block text-[11px] text-gray-500 uppercase tracking-wider font-semibold">
                Photos
              </span>
              <span className="text-sm font-bold text-gray-900">{images.length} / 10</span>
            </div>

            <div>
              <span className="block text-[11px] text-gray-500 uppercase tracking-wider font-semibold">
                Pins
              </span>
              <span className="text-sm font-bold text-gray-900">{pins.length}</span>
            </div>

            <div>
              <span className="block text-[11px] text-gray-500 uppercase tracking-wider font-semibold">
                Total Estimate
              </span>
              <span className="text-sm font-bold text-[#2563eb]">
                ₹{totalEstimate.toLocaleString("en-IN")}
              </span>
            </div>
          </div>

          <div className="w-full sm:w-auto flex flex-col sm:flex-row items-center gap-2">
            {submitError && (
              <span className="text-xs text-red-600 font-medium">{submitError}</span>
            )}
            <Button
              type="button"
              onClick={() => setShowConfirmSubmit(true)}
              disabled={images.length === 0 || pins.length === 0}
              className="touch-target w-full sm:w-auto bg-[#2563eb] hover:bg-blue-700 text-white text-xs font-semibold px-5"
            >
              Submit Report
            </Button>
          </div>
        </div>
      )}

      {/* Case 2: Status is repairing or done (Read-only summary + invoice link) */}
      {(status === "repairing" || status === "done") && (
        <div className="space-y-3">
          {finalizedApprovedCount === 0 && (
            <div className="p-3.5 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-700 font-medium text-center">
              No repairs approved. Request marked as completed.
            </div>
          )}

          <div className="p-4 rounded-xl border border-gray-200 bg-gray-50 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <span className="block text-[11px] text-gray-500 uppercase tracking-wider font-semibold">
                Final Approved Total
              </span>
              <div className="flex items-baseline gap-2">
                <span className="text-base font-bold text-gray-900">
                  ₹{finalizedApprovedTotal.toLocaleString("en-IN")}
                </span>
                <span className="text-xs text-gray-500">
                  ({finalizedApprovedCount} approved, {pins.length - finalizedApprovedCount} rejected)
                </span>
              </div>
            </div>

            <Link
              href={`/requests/${requestId}/invoice`}
              className="touch-target inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#2563eb] text-white hover:bg-blue-700 text-xs font-semibold min-h-[44px]"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>View Printable Invoice</span>
            </Link>
          </div>
        </div>
      )}

      {/* Case 3: Customer in awaiting_approval (Sticky bottom decision bar) */}
      {isCustomer && status === "awaiting_approval" && (
        <div className="sticky bottom-0 z-20 -mx-4 sm:-mx-6 p-4 bg-white/95 backdrop-blur-sm border-t border-gray-200 shadow-lg flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center justify-between w-full sm:w-auto gap-6">
            <div>
              <span className="block text-[11px] text-gray-500 uppercase tracking-wider font-semibold">
                Decisions
              </span>
              <span className="text-xs font-bold text-gray-900">
                {decidedCount} / {repairItems.length} decided
              </span>
            </div>

            <div>
              <span className="block text-[11px] text-gray-500 uppercase tracking-wider font-semibold">
                Live Approved Total
              </span>
              <span className="text-base font-bold text-[#2563eb]">
                ₹{liveApprovedTotal.toLocaleString("en-IN")}
              </span>
            </div>
          </div>

          <div className="w-full sm:w-auto flex flex-col sm:flex-row items-center gap-2">
            {decisionsError && (
              <span className="text-xs text-red-600 font-medium">{decisionsError}</span>
            )}
            <Button
              type="button"
              disabled={!allDecided || isSubmittingDecisions}
              onClick={() => setShowConfirmDecisions(true)}
              className="touch-target w-full sm:w-auto bg-[#2563eb] hover:bg-blue-700 text-white text-xs font-semibold px-6 min-h-[44px]"
            >
              Submit Decisions
            </Button>
          </div>
        </div>
      )}

      {/* Pin Bottom Sheet Dialog */}
      <PinBottomSheet
        isOpen={sheetOpen}
        pinNumber={
          editingPin
            ? pinNumberMap.get(editingPin.id)
            : pins.length + 1
        }
        initialPin={editingPin}
        coordinates={draftCoords}
        onSave={handleSavePin}
        onDelete={handleDeletePin}
        onClose={() => {
          setSheetOpen(false);
          setEditingPin(null);
          setDraftCoords(null);
        }}
      />

      {/* Confirm Delete Photo Dialog */}
      <ConfirmDialog
        isOpen={showConfirmDeleteImage}
        title="Delete Inspection Photo"
        description="Are you sure you want to delete this photo? All defect pins on this photo will also be removed."
        confirmLabel="Yes, delete photo"
        cancelLabel="Keep photo"
        variant="danger"
        isLoading={isDeletingImage}
        onConfirm={handleDeleteImageConfirm}
        onCancel={() => setShowConfirmDeleteImage(false)}
      />

      {/* Confirm Submit Report Dialog */}
      <ConfirmDialog
        isOpen={showConfirmSubmit}
        title="Submit Inspection Report"
        description="Are you sure you want to submit the inspection report? This will lock the inspection findings and send the estimated repairs to the customer for authorization."
        confirmLabel="Yes, submit report"
        cancelLabel="Continue editing"
        variant="primary"
        isLoading={isSubmittingReport}
        onConfirm={handleSubmitReportConfirm}
        onCancel={() => setShowConfirmSubmit(false)}
      />

      {/* Confirm Customer Decisions Dialog */}
      <ConfirmDialog
        isOpen={showConfirmDecisions}
        title="Submit Repair Decisions"
        description={`Submit decisions for all ${repairItems.length} repair item(s)? You have approved ${approvedCount} item(s) totaling ₹${liveApprovedTotal.toLocaleString("en-IN")} and rejected ${rejectedCount} item(s). Once submitted, decisions cannot be changed.`}
        confirmLabel="Confirm & Submit"
        cancelLabel="Review decisions"
        variant="primary"
        isLoading={isSubmittingDecisions}
        onConfirm={handleSubmitDecisionsConfirm}
        onCancel={() => setShowConfirmDecisions(false)}
      />
    </div>
  );
}

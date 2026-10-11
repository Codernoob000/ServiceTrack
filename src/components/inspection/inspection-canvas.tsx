"use client";

import * as React from "react";
import { ImageOff } from "lucide-react";
import { PinWithItem, Severity } from "@/lib/types";

interface InspectionCanvasProps {
  imageUrl?: string | null;
  pins: PinWithItem[];
  pinNumberMap: Map<string, number>;
  selectedPinId?: string | null;
  readOnly?: boolean;
  onDropPin?: (coords: { x: number; y: number }) => void;
  onPinClick?: (pin: PinWithItem) => void;
}

const SEVERITY_PIN_STYLES: Record<
  Severity,
  { bg: string; border: string; text: string; ring: string }
> = {
  low: {
    bg: "bg-emerald-600",
    border: "border-white",
    text: "text-white",
    ring: "ring-emerald-300",
  },
  medium: {
    bg: "bg-amber-600",
    border: "border-white",
    text: "text-white",
    ring: "ring-amber-300",
  },
  high: {
    bg: "bg-red-600",
    border: "border-white",
    text: "text-white",
    ring: "ring-red-300",
  },
  critical: {
    bg: "bg-rose-800",
    border: "border-white",
    text: "text-white",
    ring: "ring-rose-300",
  },
};

export function InspectionCanvas({
  imageUrl,
  pins,
  pinNumberMap,
  selectedPinId,
  readOnly = false,
  onDropPin,
  onPinClick,
}: InspectionCanvasProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);

  const [naturalDims, setNaturalDims] = React.useState<{ width: number; height: number } | null>(
    null
  );
  const [containerDims, setContainerDims] = React.useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  // Track container resize to recompute rendered rect dynamically
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateDims = () => {
      const rect = el.getBoundingClientRect();
      setContainerDims({ width: rect.width, height: rect.height });
    };

    updateDims();

    const ro = new ResizeObserver(() => {
      updateDims();
    });
    ro.observe(el);

    window.addEventListener("resize", updateDims);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateDims);
    };
  }, []);

  function handleImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    setNaturalDims({
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  }

  // Calculate rendered image rect within object-contain letterboxed container
  const renderedRect = React.useMemo(() => {
    if (
      !naturalDims ||
      naturalDims.width === 0 ||
      naturalDims.height === 0 ||
      containerDims.width === 0 ||
      containerDims.height === 0
    ) {
      return { left: 0, top: 0, width: containerDims.width, height: containerDims.height };
    }

    const containerRatio = containerDims.width / containerDims.height;
    const imageRatio = naturalDims.width / naturalDims.height;
    let width = containerDims.width;
    let height = containerDims.height;
    let left = 0;
    let top = 0;

    if (imageRatio > containerRatio) {
      // Wider than container -> letterbox top & bottom
      width = containerDims.width;
      height = containerDims.width / imageRatio;
      top = (containerDims.height - height) / 2;
    } else {
      // Taller than container -> pillarbox left & right
      height = containerDims.height;
      width = containerDims.height * imageRatio;
      left = (containerDims.width - width) / 2;
    }

    return { left, top, width, height };
  }, [naturalDims, containerDims]);

  function handleCanvasClick(e: React.MouseEvent<HTMLDivElement>) {
    if (readOnly || !onDropPin || !containerRef.current || !naturalDims) return;

    const rect = containerRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Reject taps outside rendered image rectangle
    if (
      clickX < renderedRect.left ||
      clickX > renderedRect.left + renderedRect.width ||
      clickY < renderedRect.top ||
      clickY > renderedRect.top + renderedRect.height
    ) {
      return;
    }

    // Compute normalized coordinates [0 .. 1]
    const x = Math.max(0, Math.min(1, (clickX - renderedRect.left) / renderedRect.width));
    const y = Math.max(0, Math.min(1, (clickY - renderedRect.top) / renderedRect.height));

    onDropPin({
      x: Number(x.toFixed(4)),
      y: Number(y.toFixed(4)),
    });
  }

  return (
    <div
      ref={containerRef}
      onClick={handleCanvasClick}
      className={`relative w-full aspect-[4/3] sm:aspect-[16/10] max-h-[520px] bg-gray-900 rounded-xl overflow-hidden select-none border border-gray-200 ${
        readOnly ? "cursor-default" : "cursor-crosshair"
      }`}
    >
      {/* Underlying Image */}
      {imageUrl && imageUrl.trim() !== "" ? (
        <img
          ref={imgRef}
          src={imageUrl}
          alt="Vehicle Inspection View"
          onLoad={handleImageLoad}
          className="w-full h-full object-contain pointer-events-none"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center bg-gray-100 text-gray-500 gap-2 select-none">
          <ImageOff className="w-8 h-8 text-gray-400" />
          <span className="text-xs sm:text-sm font-medium text-gray-600">Photo unavailable</span>
        </div>
      )}

      {/* Interactive Rendered Overlay for Exact Pin Alignment */}
      <div
        className="absolute pointer-events-none"
        style={{
          left: `${renderedRect.left}px`,
          top: `${renderedRect.top}px`,
          width: `${renderedRect.width}px`,
          height: `${renderedRect.height}px`,
        }}
      >
        {pins
          .filter((pin) => Boolean(pin && (pin.id || (pin as unknown as { pin_id?: string }).pin_id)))
          .map((pin) => {
            const pinId = pin.id || (pin as unknown as { pin_id?: string }).pin_id!;
            const num = pinNumberMap.get(pinId) || pinNumberMap.get(pin.id) || 1;
            const style = SEVERITY_PIN_STYLES[pin.severity] || SEVERITY_PIN_STYLES.medium;
            const isSelected = selectedPinId === pinId;

            return (
              <button
                key={pinId}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (onPinClick) onPinClick(pin);
                }}
                style={{
                  left: `${pin.x * 100}%`,
                  top: `${pin.y * 100}%`,
                }}
                className="absolute -translate-x-1/2 -translate-y-1/2 touch-target min-w-[44px] min-h-[44px] flex items-center justify-center pointer-events-auto group focus-visible:outline-2 focus-visible:outline-[#2563eb] rounded-full"
                aria-label={`Defect pin ${num}: ${pin.part_name} (${pin.severity})`}
              >
                {/* Pin Visual Badge */}
                <span
                  className={`w-7 h-7 rounded-full border-2 ${style.border} ${
                    style.bg
                  } ${style.text} text-xs font-bold flex items-center justify-center shadow-md transition-transform group-hover:scale-110 ${
                    isSelected ? `ring-4 ${style.ring} scale-110` : ""
                  }`}
                >
                  {num}
                </span>
              </button>
            );
          })}
      </div>

      {!readOnly && (
        <div className="absolute bottom-2 left-2 pointer-events-none bg-black/60 backdrop-blur-sm text-white text-[11px] px-2.5 py-1 rounded-md">
          Tap anywhere on the photo to drop a defect pin
        </div>
      )}
    </div>
  );
}

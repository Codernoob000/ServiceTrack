"use client";

import * as React from "react";
import { MoveHorizontal, ImageOff } from "lucide-react";

interface BeforeAfterSliderProps {
  beforeUrl?: string | null;
  afterUrl?: string | null;
  partName?: string;
  className?: string;
}

export function PhotoUnavailablePlaceholder({ className = "" }: { className?: string }) {
  return (
    <div
      className={`w-full h-full bg-gray-100 flex flex-col items-center justify-center text-gray-500 gap-2 select-none ${className}`}
    >
      <ImageOff className="w-8 h-8 text-gray-400" />
      <span className="text-xs sm:text-sm font-medium text-gray-600">Photo unavailable</span>
    </div>
  );
}

export function BeforeAfterSlider({
  beforeUrl,
  afterUrl,
  partName = "Repair item",
  className = "",
}: BeforeAfterSliderProps) {
  const [position, setPosition] = React.useState<number>(50);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const isDraggingRef = React.useRef<boolean>(false);

  const hasBefore = Boolean(beforeUrl && typeof beforeUrl === "string" && beforeUrl.trim() !== "");
  const hasAfter = Boolean(afterUrl && typeof afterUrl === "string" && afterUrl.trim() !== "");

  const updatePositionFromClientX = React.useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const clampedPct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setPosition(clampedPct);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    isDraggingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Fallback if pointer capture is unsupported
    }
    updatePositionFromClientX(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    updatePositionFromClientX(e.clientX);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      setPosition((prev) => Math.max(0, prev - 5));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      setPosition((prev) => Math.min(100, prev + 5));
    } else if (e.key === "Home") {
      e.preventDefault();
      setPosition(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setPosition(100);
    }
  };

  // If neither photo is available, render a neutral "Photo unavailable" box with identical dimensions
  if (!hasBefore && !hasAfter) {
    return (
      <div
        className={`relative aspect-[4/3] w-full rounded-xl overflow-hidden border border-gray-200 bg-gray-100 shadow-sm flex flex-col items-center justify-center text-gray-500 gap-2 select-none ${className}`}
      >
        <ImageOff className="w-8 h-8 text-gray-400" />
        <span className="text-xs sm:text-sm font-medium text-gray-600">Photo unavailable</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={`relative aspect-[4/3] w-full rounded-xl overflow-hidden border border-gray-200 bg-gray-100 shadow-sm select-none touch-none cursor-ew-resize group ${className}`}
    >
      {/* Before Layer (Base layer) */}
      {hasBefore ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={beforeUrl!}
          alt={`Before repair - ${partName}`}
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          loading="lazy"
        />
      ) : (
        <div className="absolute inset-0 w-full h-full">
          <PhotoUnavailablePlaceholder />
        </div>
      )}

      {/* After Layer (Clipped overlay) */}
      <div
        className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none"
        style={{
          clipPath: `inset(0 0 0 ${position}%)`,
          WebkitClipPath: `inset(0 0 0 ${position}%)`,
        }}
      >
        {hasAfter ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={afterUrl!}
            alt={`After repair - ${partName}`}
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 w-full h-full">
            <PhotoUnavailablePlaceholder />
          </div>
        )}
      </div>

      {/* Floating Labels */}
      <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-sm text-white text-[11px] font-semibold px-2.5 py-1 rounded-md shadow-sm pointer-events-none z-10">
        Before
      </div>
      <div className="absolute top-3 right-3 bg-black/60 backdrop-blur-sm text-white text-[11px] font-semibold px-2.5 py-1 rounded-md shadow-sm pointer-events-none z-10">
        After
      </div>

      {/* Draggable Divider Line & 44px Handle */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_rgba(0,0,0,0.4)] pointer-events-none z-10"
        style={{ left: `${position}%`, transform: "translateX(-50%)" }}
      >
        <div
          role="slider"
          aria-label={`Before and after comparison slider for ${partName}`}
          aria-valuenow={Math.round(position)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="pointer-events-auto absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-11 h-11 min-w-[44px] min-h-[44px] rounded-full bg-white shadow-lg border border-gray-300 flex items-center justify-center cursor-ew-resize text-gray-700 hover:scale-105 active:scale-95 transition-transform focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
        >
          <MoveHorizontal className="w-5 h-5 text-gray-700 shrink-0" />
        </div>
      </div>
    </div>
  );
}

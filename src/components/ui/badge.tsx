import * as React from "react";
import { cn } from "@/lib/utils";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "outline" | "active" | "neutral" | "danger";
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  const variantStyles = {
    default: "bg-gray-100 text-gray-800 border-gray-200",
    outline: "bg-white text-gray-700 border-gray-200",
    active: "bg-blue-50 text-[#2563eb] border-blue-200 font-semibold",
    neutral: "bg-gray-50 text-gray-600 border-gray-200",
    danger: "bg-red-50 text-red-700 border-red-200 font-semibold",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border select-none",
        variantStyles[variant],
        className
      )}
      {...props}
    />
  );
}

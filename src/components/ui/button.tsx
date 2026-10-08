import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "outline" | "danger" | "ghost";
  size?: "default" | "sm" | "lg";
  isLoading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "default", isLoading, children, disabled, ...props }, ref) => {
    const baseStyles =
      "inline-flex items-center justify-center font-medium rounded-lg transition-colors border focus-visible:outline-2 focus-visible:outline-[#2563eb] disabled:opacity-50 disabled:pointer-events-none touch-target select-none";

    const variantStyles = {
      primary: "bg-[#2563eb] text-white border-transparent hover:bg-[#1d4ed8] active:bg-[#1e40af]",
      secondary: "bg-gray-100 text-gray-900 border-gray-200 hover:bg-gray-200 active:bg-gray-300",
      outline: "bg-white text-gray-900 border-gray-200 hover:bg-gray-50 active:bg-gray-100",
      danger: "bg-red-600 text-white border-transparent hover:bg-red-700 active:bg-red-800",
      ghost: "bg-transparent text-gray-700 border-transparent hover:bg-gray-100 active:bg-gray-200",
    };

    const sizeStyles = {
      default: "px-4 py-2.5 text-sm min-h-[44px]",
      sm: "px-3 py-1.5 text-xs min-h-[36px]",
      lg: "px-6 py-3 text-base min-h-[48px]",
    };

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(baseStyles, variantStyles[variant], sizeStyles[size], className)}
        {...props}
      >
        {isLoading && (
          <svg
            className="animate-spin -ml-1 mr-2 h-4 w-4 text-current"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            ></path>
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";

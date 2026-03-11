import React from "react";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "success" | "warning" | "error" | "info" | "neutral";
  icon?: React.ReactNode;
  className?: string;
}

export function Badge({ children, variant = "neutral", icon, className }: BadgeProps) {
  return (
    <div className={`badge-glass badge-${variant} ${className || ""}`}>
      {icon && <span className="badge-icon">{icon}</span>}
      {children}
    </div>
  );
}

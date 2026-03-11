import React from "react";

interface PanelProps {
  children: React.ReactNode;
  title?: string;
  icon?: React.ReactNode;
  className?: string;
  delay?: number;
}

export function Panel({ children, title, icon, className, delay = 0 }: PanelProps) {
  return (
    <div
      className={`panel-glass ${className || ""}`}
      style={{ animationDelay: `${delay}s` }}
    >
      {(title || icon) && (
        <div className="panel-header-glass">
          {icon && <span className="panel-icon-glass">{icon}</span>}
          {title && <span className="panel-title-glass">{title}</span>}
        </div>
      )}
      <div className="panel-content-glass">{children}</div>
    </div>
  );
}

import { clsx } from "clsx";
import type { CSSProperties, ReactNode } from "react";

interface CardProps {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  variant?: "default" | "primary" | "secondary" | "accent";
}

export function Card({
  title,
  children,
  className,
  style,
  variant = "default",
}: CardProps) {
  const variantStyles = {
    default: "bg-base-100",
    primary: "bg-primary/10 border-primary",
    secondary: "bg-secondary/10 border-secondary",
    accent: "bg-accent/10 border-accent",
  };

  return (
    <div
      className={clsx(
        "card-doodle p-3 sm:p-4",
        variantStyles[variant],
        className,
      )}
      style={style}
    >
      {title && (
        <h3 className="mb-2 flex items-center gap-1.5 font-heading text-md font-bold">
          {typeof title === "string" ? (
            <span className="underline-sketch">{title}</span>
          ) : (
            title
          )}
        </h3>
      )}
      {children}
    </div>
  );
}

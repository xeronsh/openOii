import { clsx } from "clsx";
import type { InputHTMLAttributes } from "react";
import { useId } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className, ...props }: InputProps) {
  const id = useId();

  return (
    <div className="form-control w-full gap-1">
      {label && (
        <label htmlFor={id} className="label min-h-0 p-0">
          <span className="label-text font-heading text-xs font-medium">
            {label}
          </span>
        </label>
      )}
      <input
        id={id}
        className={clsx(
          "input-doodle h-9 min-h-9 w-full px-2.5 py-1.5 text-base",
          error && "border-error",
          className,
        )}
        {...props}
      />
      {error && (
        <label className="label min-h-0 p-0">
          <span className="label-text-alt text-2xs text-error">
            {error}
          </span>
        </label>
      )}
    </div>
  );
}

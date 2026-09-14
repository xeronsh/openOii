import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import { useToastStore } from "~/stores/toast.store";
import type { Toast as ToastType } from "~/types/errors";

interface ToastProps {
  toast: ToastType;
}

export function Toast({ toast }: ToastProps) {
  const removeToast = useToastStore((state) => state.removeToast);

  useEffect(() => {
    if (toast.duration > 0) {
      const timer = setTimeout(() => {
        removeToast(toast.id);
      }, toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast.id, toast.duration, removeToast]);

  const typeStyles = {
    success: "border-success",
    error: "border-error",
    warning: "border-warning",
    info: "border-info",
  };

  return (
    <div
      className={`
        relative min-w-[16rem] max-w-[22rem] border-2 bg-base-100 p-3
        shadow-brutal-sm ${typeStyles[toast.type]}
        animate-slide-in-right
      `}
      role="status"
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <h4 className="m-0 font-heading text-sm font-bold leading-snug">
          {toast.title}
        </h4>
        <button
          type="button"
          onClick={() => removeToast(toast.id)}
          className="btn btn-ghost btn-circle touch-target-dense h-7 min-h-7 w-7 hover:bg-base-200"
          aria-label="关闭"
        >
          <XMarkIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="m-0 text-xs leading-snug text-base-content/75">
        {toast.message}
      </p>

      {toast.actions && toast.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {toast.actions.map((action, index) => (
            <button
              key={index}
              type="button"
              onClick={() => {
                action.onClick();
                removeToast(toast.id);
              }}
              className={`btn btn-xs h-7 min-h-7 border-2 border-base-content/30 px-2 ${
                action.variant === "primary"
                  ? "btn-primary"
                  : "btn-ghost hover:bg-base-200"
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

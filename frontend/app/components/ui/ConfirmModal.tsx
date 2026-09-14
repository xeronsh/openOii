import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning" | "info";
  isLoading?: boolean;
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = "确认操作",
  message,
  confirmText = "确认",
  cancelText = "取消",
  variant = "danger",
  isLoading = false,
}: ConfirmModalProps) {
  if (!isOpen) return null;

  const variantStyles = {
    danger: {
      icon: "text-error",
      iconBg: "bg-error/10",
      button: "btn-error",
    },
    warning: {
      icon: "text-warning",
      iconBg: "bg-warning/10",
      button: "btn-warning",
    },
    info: {
      icon: "text-info",
      iconBg: "bg-info/10",
      button: "btn-info",
    },
  };

  const styles = variantStyles[variant];

  return (
    <dialog className="modal modal-open" open role="dialog" aria-modal="true">
      <div className="modal-box max-w-md border-2 border-base-content/20 bg-base-100 p-4 shadow-brutal-sm">
        <div className="flex items-start gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${styles.iconBg}`}
          >
            <ExclamationTriangleIcon className={`h-5 w-5 ${styles.icon}`} />
          </div>

          <div className="min-w-0 flex-1">
            <h3 className="m-0 font-heading text-md font-bold">
              {title}
            </h3>
            <p className="m-0 mt-1 text-sm text-bc-muted">
              {message}
            </p>
          </div>
        </div>

        <div className="modal-action mt-3 gap-2">
          <button
            type="button"
            className="btn btn-ghost h-9 min-h-9 border-2 border-base-content/20 px-3 text-sm"
            onClick={onClose}
            disabled={isLoading}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={`btn ${styles.button} h-9 min-h-9 border-2 border-base-content/20 px-3 text-sm`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading && (
              <span className="loading loading-spinner loading-sm" />
            )}
            {confirmText}
          </button>
        </div>
      </div>

      <form method="dialog" className="modal-backdrop bg-neutral/45">
        <button type="button" onClick={onClose} disabled={isLoading}>
          close
        </button>
      </form>
    </dialog>
  );
}

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
      button: "bg-error text-error-content",
    },
    warning: {
      icon: "text-warning",
      iconBg: "bg-warning/10",
      button: "bg-warning text-warning-content",
    },
    info: {
      icon: "text-info",
      iconBg: "bg-info/10",
      button: "bg-info text-info-content",
    },
  };

  const styles = variantStyles[variant];

  return (
    <div
      className="dialog-overlay"
      onClick={(event) => {
        if (!isLoading && event.target === event.currentTarget) onClose();
      }}
    >
      <div
			className="dialog-panel w-full max-w-md p-4"
			role="dialog"
			aria-modal="true"
			aria-labelledby="confirm-modal-title"
		>
        <div className="flex items-start gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${styles.iconBg}`}
          >
            <ExclamationTriangleIcon className={`h-5 w-5 ${styles.icon}`} />
          </div>

          <div className="min-w-0 flex-1">
            <h3
				id="confirm-modal-title"
				className="m-0 font-heading text-md font-bold"
			>
              {title}
            </h3>
            <p className="m-0 mt-1 text-sm text-ink-muted">
              {message}
            </p>
          </div>
        </div>

        <div className="dialog-actions">
          <button
            type="button"
            className="btn-doodle bg-transparent border-transparent shadow-none hover:bg-paper-200 hover:shadow-brutal-sm h-9 min-h-9 border-2 border-ink/20 px-3 text-sm"
            onClick={onClose}
            disabled={isLoading}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={`btn-doodle ${styles.button} h-9 min-h-9 border-2 border-ink/20 px-3 text-sm`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading && (
              <span className=" spinner-doodle h-4 w-4" />
            )}
            {confirmText}
          </button>
        </div>
      </div>

    </div>
  );
}

import { useToastStore } from "~/stores/toast.store";
import { Toast } from "./Toast";

export function ToastContainer() {
  const toasts = useToastStore((state) => state.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed top-3 right-3 z-tooltip flex flex-col gap-2 sm:top-4 sm:right-4">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <Toast toast={toast} />
        </div>
      ))}
    </div>
  );
}

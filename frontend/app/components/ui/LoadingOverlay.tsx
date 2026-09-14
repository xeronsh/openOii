interface LoadingOverlayProps {
  text?: string;
  className?: string;
}

export function LoadingOverlay({ text, className }: LoadingOverlayProps) {
  return (
    <div
      className={`absolute inset-0 z-sticky flex flex-col items-center justify-center bg-base-100/80 ${
        className || ""
      }`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span
        className="loading loading-spinner loading-lg text-primary"
        aria-hidden="true"
      />
      {text ? (
        <p className="mt-3 font-heading text-sm font-bold text-base-content/80">
          {text}
        </p>
      ) : null}
    </div>
  );
}

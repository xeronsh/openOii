interface LoadingOverlayProps {
  text?: string;
  className?: string;
}

export function LoadingOverlay({ text, className }: LoadingOverlayProps) {
  return (
    <div
      className={`absolute inset-0 z-sticky flex flex-col items-center justify-center bg-paper-100/80 ${
        className || ""
      }`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span
        className=" spinner-doodle h-6 w-6 text-primary"
        aria-hidden="true"
      />
      {text ? (
        <p className="mt-3 font-heading text-sm font-bold text-ink/80">
          {text}
        </p>
      ) : null}
    </div>
  );
}

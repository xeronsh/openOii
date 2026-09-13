import { useState, useCallback } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import { clsx } from "clsx";

interface CollapsibleMessageProps {
  summary: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  className?: string;
}

export function CollapsibleMessage({
  summary,
  children,
  defaultExpanded = false,
  className,
}: CollapsibleMessageProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const toggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  return (
    <div className={clsx("collapsible-message", className)}>
      {isExpanded ? (
        <div>
          {children}
          <button
            type="button"
            onClick={toggle}
            className="mt-1.5 flex items-center gap-1 text-2xs text-bc-muted transition-colors duration-fast hover:text-base-content/80"
            aria-label="收起详情"
          >
            <ChevronUpIcon className="h-3 w-3" aria-hidden="true" />
            <span>收起</span>
          </button>
        </div>
      ) : (
        <div
          onClick={toggle}
          className="-m-1.5 cursor-pointer rounded-md p-1.5 transition-colors duration-fast hover:bg-base-200/50"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          }}
          aria-label="展开查看详情"
        >
          <p className="m-0 text-sm text-base-content/80">{summary}</p>
          <div className="mt-0.5 flex items-center gap-1 text-2xs text-bc-muted">
            <ChevronDownIcon className="h-3 w-3" aria-hidden="true" />
            <span>点击展开</span>
          </div>
        </div>
      )}
    </div>
  );
}

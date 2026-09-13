import { lazy, Suspense } from "react";

interface StageViewProps {
  projectId: number;
  onSelectedNodeIdChange?: (nodeId: string | null) => void;
  onSelectedNodeIdsChange?: (nodeIds: string[]) => void;
}

const InfiniteCanvas = lazy(() =>
  import("~/features/comic-workflow/canvas/ComicWorkflowCanvas").then((m) => ({
    default: m.ComicWorkflowCanvas,
  })),
);

export function StageView({
  projectId,
  onSelectedNodeIdChange,
  onSelectedNodeIdsChange,
}: StageViewProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center bg-base-100 text-sm text-bc-muted">
          正在加载画布...
        </div>
      }
    >
      <InfiniteCanvas
        key={projectId}
        projectId={projectId}
        onSelectedNodeIdChange={onSelectedNodeIdChange}
        onSelectedNodeIdsChange={onSelectedNodeIdsChange}
      />
    </Suspense>
  );
}

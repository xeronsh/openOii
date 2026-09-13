import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StageView } from "./StageView";

vi.mock("~/stores/editorStore", () => ({
  useEditorStore: () => ({
    currentStage: "plan",
    shots: [],
    characters: [],
  }),
  useShallow: (selector: any) => {
    const result = selector({ currentStage: "plan", shots: [], characters: [] });
    return () => result;
  },
}));

vi.mock("~/features/comic-workflow/canvas/ComicWorkflowCanvas", () => ({
  ComicWorkflowCanvas: ({ projectId }: { projectId: number }) => (
    <div data-testid="projected-canvas">project:{projectId}</div>
  ),
}));

describe("StageView projected shell", () => {
  it("opens empty ideate projects into the projected canvas shell", async () => {
    render(<StageView projectId={42} />);

    expect(await screen.findByTestId("projected-canvas")).toHaveTextContent("project:42");
    expect(screen.queryByText("构思你的故事")).not.toBeInTheDocument();
  });
});

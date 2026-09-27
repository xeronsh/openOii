import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("returns null when isOpen is false", () => {
    const { container } = render(
      <Modal isOpen={false} onClose={vi.fn()}>
        content
      </Modal>
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders content when isOpen is true", () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()}>
        <p>modal body</p>
      </Modal>
    );
    expect(screen.getByText("modal body")).toBeInTheDocument();
  });

  it("renders title when provided", () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test Title">
        content
      </Modal>
    );
    expect(screen.getByText("Test Title")).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose}>
        content
      </Modal>
    );
    // The close button is inside the dialog actions.
    const closeButtons = screen.getAllByText("关闭");
    fireEvent.click(closeButtons[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose}>
        content
      </Modal>
    );
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape key", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose}>
        content
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders actions when provided", () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} actions={<button>Save</button>}>
        content
      </Modal>
    );
    expect(screen.getByText("Save")).toBeInTheDocument();
  });
});

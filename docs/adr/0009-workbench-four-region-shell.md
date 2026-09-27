# Workbench four-region shell

The workbench is one primary window with three persistent panes plus a pinned
prompt bar: **Activity (18rem) | Canvas (1fr) | Inspector (20rem)**, with the
PromptBar under the canvas. Roles are assigned before geometry, and the canvas is
the only flexible pane.

## Context

Layout selection follows the criteria in `docs/research/layout-pattern-research.md`
and the viewport-architecture pattern: content dependency decides master–detail
vs. focus–supporting, and a large desktop view gets **at most three persistent
non-floating panes**.

The workbench had three unrelated surfaces competing for the same space:

1. `WorkspaceSidebar` floated over the canvas via `lg:absolute lg:left-2`, hiding the
   canvas's left edge (2.75rem collapsed, 18rem expanded).
2. The canvas already drew its own three columns (Brief + cast | shot grid | output),
   so the floating panel was a second three-column layout stacked on the first.
3. Chat, inspector, assets and universe were siblings in one tablist even though they
   have different relationships to the selection — the inspector is context-bound
   (`bound to master`), the other three are independent/global.

## Decisions

### 1. Persistent panes replace the floating overlay

Activity and Inspector occupy their own columns. Nothing overlays the canvas, so the
canvas never loses an edge and never needs a viewport recompute when a panel opens.

### 2. Brief leaves the canvas; the canvas keeps two columns

Brief is project-level context, not something that needs spatial comparison against
shots. Removing it drops the canvas from three columns to two and lets the Inspector
own it. The on-canvas chain keeps only what genuinely benefits from spatial reading:
cast → shot grid → output.

This is zero functionality loss: the canvas `BriefCard` was read-only, and the
Inspector's existing `ProjectDraftForm` was already the only editor for those fields
(`inspector/WorkflowInspector.tsx` already had a `node.kind === "brief"` branch).

### 3. PromptBar is pinned under the canvas

It previously lived inside the sidebar's chat tab, behind `collapsed && "hidden"` —
and `workspaceCollapsed` defaults to `true`. The core interaction
(select → prompt → targeted rerun) therefore had no entry point in the default state.
It now sits in its own region under the canvas, always visible.

### 4. Inspector follows Figma

Opens on select, collapses to a 2.75rem rail on request, and falls back to Brief when
nothing is selected so project-level context stays reachable without clicking a card.
A manual collapse is remembered per selection target rather than re-opening on the
next render.

## Consequences

- Narrow (`<lg`): the Inspector is not rendered, Activity returns to document flow.
  The primary action never disappears.
- Pane budget stays at three; anything further becomes an overlay/drawer, per the
  yuuvis composition rule.
- Related: ADR 0003 (interaction soft freeze) — selection binding, generate/confirm/
  cancel and viewport lock keep their meaning.

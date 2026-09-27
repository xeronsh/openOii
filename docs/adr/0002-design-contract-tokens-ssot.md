# Design Contract: tokens are source of truth

Visual consistency for the full-frontend redesign is enforced by **executable tokens** (`frontend/app/styles/tokens.css`) mapped directly through Tailwind. No external UI theme layer supplies colors or component styles. `DESIGN.md` remains the human-readable narrative and is updated in the **same PR** when token geometry or palette roles change (light dual-write). Rejected: doc-first design system that drifts from code; heavy dual-write generators that violate KISS.

---
name: openOii
description: "AI 漫剧生成平台：故事创意 → 3 Agent 协作 → 可视化漫剧成片"
colors:
  inkwell-gold: "#E8B730"
  inkwell-gold-content: "#1a1a1a"
  press-magenta: "#D45E8B"
  press-magenta-content: "#ffffff"
  ink-cyan: "#2AA8B8"
  ink-cyan-content: "#ffffff"
  inkwell-dark: "#1E1E2E"
  inkwell-dark-content: "#E6EDF3"
  workshop-cream: "#FAFAF5"
  workshop-linen: "#F0EFE6"
  workshop-ecru: "#E2E0D4"
  workshop-text: "#2C2C3A"
  pressroom-base: "#16161E"
  pressroom-surface: "#1E1E28"
  pressroom-elevated: "#28283A"
  pressroom-text: "#D8D8E8"
  dark-inkwell-gold: "#F0C050"
  dark-press-magenta: "#E06898"
  dark-ink-cyan: "#40C0D0"
  dark-inkwell: "#2A2A3A"
  dark-inkwell-content: "#D0D0E0"
  semantic-success: "#4CAF7D"
  semantic-warning: "#E8943A"
  semantic-error: "#C03A3A"
  semantic-info: "#2AA8B8"
typography:
  display:
    fontFamily: "Bangers, Impact, sans-serif"
    fontSize: "clamp(1.75rem, 5vw, 3.5rem)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.04em"
  headline:
    fontFamily: "Fredoka, Comic Neue, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "Fredoka, Comic Neue, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Nunito, Comic Neue, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    letterSpacing: "0.05em"
  sketch:
    fontFamily: "Caveat, cursive"
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
alpha:
  rule: "5 的倍数；/8 /12 /65 这类随手档已收敛"
  common: "5 10 15 20 30 40 50 70 90"
components:
  button-primary:
    backgroundColor: "{colors.inkwell-gold}"
    textColor: "{colors.inkwell-gold-content}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-primary-hover:
    backgroundColor: "oklch(78% 0.14 85)"
  button-secondary:
    backgroundColor: "{colors.press-magenta}"
    textColor: "{colors.press-magenta-content}"
    rounded: "{rounded.md}"
  button-accent:
    backgroundColor: "{colors.ink-cyan}"
    textColor: "{colors.ink-cyan-content}"
    rounded: "{rounded.md}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.workshop-text}"
    rounded: "{rounded.md}"
  card-doodle:
    backgroundColor: "{colors.workshop-cream}"
    rounded: "{rounded.xl}"
  card-comic:
    backgroundColor: "{colors.workshop-cream}"
    rounded: "{rounded.lg}"
  input-doodle:
    backgroundColor: "{colors.workshop-cream}"
    rounded: "{rounded.lg}"
---

# Design System: openOii

## 0. Design Contract (executable)

**Authority:** `frontend/app/styles/tokens.css` is the source of truth. This document is human-readable; update it in the **same PR** when tokens change (ADR 0002).

**Aesthetic (D2):** Dense Comic Workbench — keep CMYK offset shadows, halftone, Bangers/Fredoka/Nunito. Tighten chrome and cards to cockpit density. Not cold SaaS grey; not dual themes.

**Shell geometry (tokens):**

| Token | Role |
|-------|------|
| `--workbench-header` / `--workbench-toolbar` | TopBar + stage row (each 2.75rem) |
| `--workbench-sidebar` | Agent Column width (18rem) |

画布几何（卡片尺寸、九宫格列数、frame 内距 gap）的 SSOT 是
`app/features/comic-workflow/graph/layoutComicWorkflow.ts`——tldraw 消费的是
px 数值，tokens.css 不保留 rem 副本（避免两套数字漂移）。

**Token → Utility 映射（强制）：**

`tailwind.config.ts` 的 `theme.extend` 把 token 映射成裸类，**源码里必须写裸类**：

| token | 写字 | 禁止写 |
|-------|------|--------|
| `--text-sm` | `text-sm` | ~~`text-[length:var(--text-sm)]`~~ |
| `--radius-md` | `rounded-md` | ~~`rounded-[var(--radius-md)]`~~ |
| `--z-modal` | `z-modal` | ~~`z-[var(--z-modal)]`~~、~~`z-50`~~ |
| `--duration-fast` | `duration-fast` | ~~`duration-[var(--duration-fast)]`~~、~~`duration-150`~~ |
| `--leading-tight` | `leading-tight` | ~~`leading-4`~~ |
| `--rhythm-zone` | `gap-5` | ~~`gap-[var(--rhythm-zone)]`~~ |

不透明度阶梯只允许 5 的倍数（`base-content/8` 这类随手档已收敛）。
focus ring 不手写：全局 `:focus-visible` 已是 2px primary outline，别再加 `focus-visible:outline-*` / `ring-*`。
执行者：`app/styles/designContract.test.ts`（几何）+ `themeContrast.test.ts`（颜色）。

**Layout rules:**

1. **No document scroll** — `html`/`body`/`#root` overflow hidden; only `.page-body` / panel panes scroll.
2. **Interaction soft freeze** — selection binding, Agent Column chat, cell regenerate, generate/confirm/cancel keep meaning (ADR 0003).
3. **One display face per screen** — Bangers at most once.
4. **Dense chrome** — header/toolbar use `--touch-target-dense` for chips; primary actions keep `--touch-target-min` (44px).
5. **Shell classes** — TopBar → `.chrome-row` + `data-shell="topbar"`; StagePipeline → `.chrome-toolbar` + `data-shell="stage-pipeline"`; pages → `.page-shell` / `.page-body`.

**Program:** Full UI domains land in batches (`docs/frontend-redesign-program.md`).

## 1. Overview

**Creative North Star: "The Comic Workbench"**

A comic artist's workbench: professional, energetic, and immediately recognizable as a craft space, not a corporate tool. The surface is warm cream paper under ink. CMYK offset shadows and halftone dot textures are structural references to the printing process that gives comics their visual identity. Every design choice answers "does this feel like the workshop where comics get made?"

The system speaks two fluencies simultaneously: comic-book visual language (Bangers display type, CMYK shadows, halftone backgrounds, speech-bubble chat) and tool-clarity interaction (predictable grid layouts, consistent component vocabulary, 200ms state transitions). Comic energy without comic chaos. The workbench has inks, ruling pens, and registration marks, but the artist reaches for the right tool without thinking.

This system explicitly rejects three aesthetics: the grey SaaS panel (Notion/Jira coldness), the generic AI generator (white card grids + purple gradients), and the childlike doodle (over-rounded corners, candy colors, infantile typography). If it looks like a Jira ticket, the warmth is missing. If it looks like a Midjourney landing page, the personality is missing. If it looks like a kindergarten sticker chart, the craft is missing.

**Key Characteristics:**
- CMYK offset shadows as structural elevation, not decoration
- Halftone dot textures as surface identity markers
- Speech-bubble chat pattern grounded in comic convention
- Tactile button press (translate on active, shadow collapse) with physical feedback
- Dual-theme: warm cream workshop (light) / pressroom darkroom (dark)
- **Dense desk density** — more cells and messages on screen without losing craft identity

## 2. Colors

The palette is a CMYK printing system translated to a UI: Cyan for structural elements, Magenta for emphasis and interaction, Yellow (Gold) for primary action and warmth. Neutrals are warm cream paper (light) or pressroom ink-black (dark), both tinted toward the yellow axis.

### Primary
- **Inkwell Gold** (#E8B730): Primary action buttons, active states, stage progress dots. The warm anchor that says "this is where you act." Light theme only; dark theme uses Dark Inkwell Gold (#F0C050) with increased chroma to maintain punch against the dark surface.

### Secondary
- **Press Magenta** (#D45E8B): Secondary interactions, accent highlights, speech-bubble user messages. The spot-color that registers attention without competing with primary actions. Dark theme shifts to #E06898 for contrast.

### Tertiary
- **Ink Cyan** (#2AA8B8): Tertiary accent, card-comic first shadow layer, info semantic state. The cyan plate in CMYK, used structurally in offset shadows and as a registration-mark accent. Dark theme shifts to #40C0D0.

### Neutral
- **Workshop Cream** (#FAFAF5): Base-100 surface in light theme. Warm paper white, tinted yellow to avoid clinical sterility.
- **Workshop Linen** (#F0EFE6): Base-200 in light theme. Sidebar and panel backgrounds. Slightly cooler cream.
- **Workshop Ecru** (#E2E0D4): Base-300 in light theme. Elevated surfaces, input backgrounds, speech-bubble fills.
- **Workshop Text** (#2C2C3A): Primary text in light theme. Near-black with blue undertone for depth.
- **Pressroom Base** (#16161E): Base-100 surface in dark theme. Deep ink-black with blue undertone.
- **Pressroom Surface** (#1E1E28): Base-200 in dark theme. Sidebar and panel layer.
- **Pressroom Elevated** (#28283A): Base-300 in dark theme. Input backgrounds, elevated cards.
- **Pressroom Text** (#D8D8E8): Primary text in dark theme. Warm white with blue cast.

### Named Rules

**The CMYK Registration Rule.** The three accent colors (Inkwell Gold, Press Magenta, Ink Cyan) are the Cyan, Magenta, and Yellow plates. They are always used in their printing-register role: Gold for primary action, Magenta for emphasis, Cyan for structural accent. No plate swaps, no "use magenta because it looks nice here." The registration is the system.

**The Warm Neutral Rule.** Every neutral is tinted toward the yellow axis (hue ~85 in OKLCH). Pure grey or blue-grey neutrals are prohibited. If a neutral could be mistaken for a SaaS palette, it needs more warmth.

## 3. Typography

**Display Font:** Bangers (Impact fallback)
**Heading Font:** Fredoka (Comic Neue fallback)
**Body Font:** Nunito (Comic Neue fallback)
**Sketch Font:** Caveat (cursive fallback)
**Label/Mono Font:** JetBrains Mono (Menlo fallback)

**Character:** The pairing is a printing-shop conversation: Bangers shouts the headline from across the room, Fredoka carries the subhead with confident roundness, Nunito does the patient body work, and JetBrains Mono handles the registration marks and technical labels. Caveat is the hand-lettered margin note, used sparingly for personality.

### Hierarchy
- **Display** (400, clamp(1.75rem, 5vw, 3.5rem), line-height 1): Comic book cover titles. Splash text on hero sections. The only place Bangers is used. Letter-spacing 0.04em for optical balance.
- **Headline** (700, 1.5rem, line-height 1.2): Section titles, sidebar project names, modal headers. Fredoka at its boldest.
- **Title** (600, 1.125rem, line-height 1.3): Card titles, button text at large sizes, toast messages. Fredoka at medium weight.
- **Body** (400, 0.875rem, line-height 1.5): All running text. Paragraphs, descriptions, chat messages. Max line length 65-75ch. Nunito's rounded terminals maintain warmth at reading length.
- **Label** (500, 0.75rem, letter-spacing 0.05em): Status indicators, metadata, timestamps, technical data. JetBrains Mono uppercase for registration-mark precision.
- **Sketch** (400, 1.25rem, line-height 1.4): Decorative hand-lettered text. Tooltips, hint text, personality touches. Caveat only. Used no more than once per screen to preserve impact.

### Named Rules

**The One Display Rule.** Bangers appears at most once per screen. If a second element needs display weight, use Fredoka 700 at headline size. Display type that appears twice is display type that has lost its punch.

**The Mono-For-Data Rule.** JetBrains Mono is reserved for status labels, timestamps, technical identifiers, and code. Never use it for button labels, headings, or body text. If it reads like a registration mark, it belongs in Mono. If it reads like a sentence, it does not.

## 4. Elevation

The Comic Workbench uses CMYK offset shadows as structural elevation. Shadows are not ambient (they don't simulate light falling on objects); they are offset-printing registration marks that communicate layer identity. Each shadow layer is a "plate" with a specific color role.

### Shadow Vocabulary
- **Brutal** (`4px 4px 0px 0px oklch(var(--bc) / 0.3)`): Default card elevation. Single-plate offset shadow in the base-content color. Used on card-doodle, btn-doodle.
- **Brutal Small** (`2px 2px 0px 0px oklch(var(--bc) / 0.3)`): Subtle elevation for small elements (chips, tags, inline badges).
- **Brutal Large** (`6px 6px 0px 0px oklch(var(--bc) / 0.3)`): Hover-state elevation. The shadow grows when the card is lifted.
- **Comic** (`4px 4px 0px 0px oklch(var(--cmyk-cyan) / 0.7), 7px 7px 0px 0px oklch(var(--cmyk-magenta) / 0.5)`): Two-plate CMYK shadow. Cyan first layer, magenta second layer, both theme-aware via `--cmyk-cyan` / `--cmyk-magenta`. Used on card-comic. Signals "this element has a distinct visual identity."
- **Comic Magenta** (`4px 4px 0px 0px oklch(var(--cmyk-magenta) / 0.7), 7px 7px 0px 0px oklch(var(--bc) / 0.3)`): Magenta first layer. Used for emphasis variants, pressed states, or elements that demand attention.
- **Comic Pop** (`5px 5px 0px 0px oklch(var(--cmyk-cyan) / 0.8), 9px 9px 0px 0px oklch(var(--cmyk-magenta) / 0.6)`): Larger CMYK shadow. Hover state for comic elements. The expanded offset signals "this plate has shifted during printing."

### Tonal Layering
- **Light theme**: Three cream surfaces (Workshop Cream/Linen/Ecru) form tonal layers without shadow. Panels and sidebars use Linen (#F0EFE6), the canvas uses Cream (#FAFAF5), and elevated inputs use Ecru (#E2E0D4).
- **Dark theme**: Three pressroom surfaces (Pressroom Base/Surface/Elevated) form the same tonal system. Shadow opacity increases from 0.25 to 0.4 in dark mode to maintain CMYK visibility against dark backgrounds.

### Named Rules

**The Offset-Is-Structure Rule.** CMYK shadows are structural elevation, not decorative drop shadows. A card-comic with its Comic shadow has higher visual weight than a card-doodle with its Brutal shadow. Removing a shadow changes the element's hierarchy, not just its decoration. Never remove a shadow for aesthetics alone.

**The Flat-At-Rest Rule.** Elements are flat (no translate) at rest. Hover lifts the element (-0.5px translate) and expands the shadow offset. Active presses the element (+1px translate) and collapses the shadow entirely. This physical model (lift, press, snap) is the tactile foundation.

## 5. Components

### Buttons
- **Shape:** Rounded (8px), bold 3px border, uppercase tracking
- **Primary (Inkwell Gold):** `btn-doodle` with `bg-primary text-primary-content`. 3px border in `base-content/30`, brutal shadow, font-heading bold. Padding: md (20px 10px), lg (28px 12px).
- **Secondary (Press Magenta):** `bg-secondary text-secondary-content`. Same shadow model.
- **Accent (Ink Cyan):** `bg-accent text-accent-content`. Same shadow model.
- **Ghost:** Transparent background, no border, no shadow. Hover adds `bg-base-200` and `shadow-brutal-sm`.
- **Error:** `bg-error text-error-content`. Same shadow model.
- **Hover:** Translate -0.5px, shadow expands from brutal to brutal-lg (or comic to comic-pop for comic variants).
- **Active:** Translate +1px, shadow collapses to none. The button physically presses into the surface.
- **Disabled:** 50% opacity, cursor-not-allowed. No hover or active transforms.
- **Loading:** DaisyUI spinner replaces content. All interaction blocked.

### Cards / Containers
- **card-doodle:** Rounded-xl (16px), 3px border, brutal shadow. Background: Workshop Cream. Hover: -0.5px translate, shadow to brutal-lg. The default card for content sections.
- **card-comic:** Rounded-lg (12px), 3px border, comic shadow (cyan first plate). Background: Workshop Cream. Hover: comic-pop shadow. Dark mode hover: increased border and shadow opacity. The identity card for featured content and canvas sections.
- **Internal padding:** 24px (p-6) standard, 16px (p-4) compact.

### Inputs / Fields
- **input-doodle:** 3px border in `base-content/30`, rounded-lg (8px), Workshop Cream background. Focus: border shifts to primary (Inkwell Gold). No glow, no ring, just a decisive border-color change.
- **Error state:** Border shifts to error color (`#C03A3A` light / `#E86868` dark). Error message in error color below.
- **Label:** font-heading medium weight, sitting above the input.

### Chips / Tags
- **Style:** Rounded-full, thin border, bg-base-200 surface. Selected state uses the accent color (Ink Cyan) as background tint.
- **State:** Unselected: base-200 bg, base-content text. Selected: accent/10 bg, accent text with accent border.

### Navigation
- **Sidebar:** 288px overlay panel (18rem, `--workbench-sidebar`), Pressroom Surface / Workshop Linen background. Active project: left border highlight in Inkwell Gold (3px). Project names in font-heading, compact row layout. Delete button revealed on hover only.
- **TopBar:** 44px height (2.75rem, `--workbench-header`), 2px thick bottom border, compact dot+icon+label stage indicators. Bold progress dots in stage accent color. Stage labels in font-heading.

### Speech Bubbles
- **speech-bubble:** Rounded-xl, base-300/50 background, font-comic type. Left-pointing triangle arrow (6px border-width) for AI messages.
- **speech-bubble-user:** Rounded-xl, primary/10 background. Right-pointing triangle arrow for user messages. Dark mode: increased arrow opacity from 0.1 to 0.3.
- **Use case:** Chat panel messages. The directional arrows follow comic convention (left = incoming, right = outgoing).

### Halftone Backgrounds
- **halftone-bg:** Radial gradient dots in `base-content / 0.08`, 7px grid. Standard background texture for sections needing surface identity.
- **halftone-bg-accent:** Dots in `primary / 0.16`, 7px grid. Accent variant for hero sections and featured areas.
- **Dark mode:** Opacity increases (0.08→0.2, 0.16→0.3) to maintain halftone visibility against dark surfaces.

## 6. Do's and Don'ts

### Do:
- **Do** use CMYK offset shadows to communicate visual hierarchy. A comic-shadow card has more weight than a brutal-shadow card.
- **Do** translate elements on hover/active for tactile press feedback: lift (-0.5px), then press (+1px).
- **Do** tint all neutrals warm (toward the yellow axis). Pure greys and blue-greys are SaaS territory.
- **Do** use halftone dot backgrounds as surface identity markers, especially on hero sections and canvas areas.
- **Do** keep Bangers display font to one appearance per screen. More dilutes its punch.
- **Do** use speech-bubble directional arrows to distinguish AI vs. user messages in chat.
- **Do** increase shadow and halftone opacity in dark mode (2-2.5x) to maintain CMYK visibility.
- **Do** use JetBrains Mono only for status labels, timestamps, and technical identifiers.

### Don't:
- **Don't** use pure #000 or #fff for any element. Every neutral must be tinted toward the brand hue.
- **Don't** create grey SaaS panels. If a sidebar looks like it belongs in Jira, it needs Workshop Linen warmth.
- **Don't** use generic AI tool aesthetics: white card grids with purple gradients are the exact opposite of The Comic Workbench.
- **Don't** apply childlike doodle aesthetics: over-rounded corners, candy colors, infantile typography. This is a professional workshop, not a sticker chart.
- **Don't** use border-left or border-right greater than 1px as a colored accent stripe. Use full borders, background tints, or nothing.
- **Don't** use gradient text (`background-clip: text` with gradient). Solid colors only.
- **Don't** use glassmorphism (blurs, glass cards) as default surface treatment.
- **Don't** decorate with CMYK shadows. If removing a shadow would change the hierarchy, it's structural and stays. If removing it changes nothing, it's decorative and must go.
- **Don't** use display fonts (Bangers) in UI labels, buttons, or data. Display is for splash, not for interaction.
- **Don't** reinvent standard affordances (custom scrollbars, weird form controls, non-standard modals). The workbench has familiar tools.

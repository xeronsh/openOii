import type { Config } from "tailwindcss";
import daisyui from "daisyui";

export default {
  content: ["./app/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      // —— Design Contract tokens ——
      // SSOT: app/styles/tokens.css。裸类直接解析到 token，
      // 因此禁止再写 text-[length:var(--text-sm)] / rounded-[var(--radius-md)] / z-[var(--z-modal)]。
      borderRadius: {
        DEFAULT: "var(--radius-sm)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      fontSize: {
        "2xs": "var(--text-2xs)",
        xs: "var(--text-xs)",
        sm: "var(--text-sm)",
        base: "var(--text-base)",
        md: "var(--text-md)",
        lg: "var(--text-lg)",
        xl: "var(--text-xl)",
      },
      lineHeight: {
        tight: "var(--leading-tight)",
        snug: "var(--leading-snug)",
        normal: "var(--leading-normal)",
      },
      spacing: {
        0: "var(--space-0)",
        1: "var(--space-1)",
        2: "var(--space-2)",
        3: "var(--space-3)",
        4: "var(--space-4)",
        5: "var(--space-5)",
        6: "var(--space-6)",
        8: "var(--space-8)",
        10: "var(--space-10)",
        12: "var(--space-12)",
      },
      zIndex: {
        dropdown: "var(--z-dropdown)",
        sticky: "var(--z-sticky)",
        fixed: "var(--z-fixed)",
        "modal-backdrop": "var(--z-modal-backdrop)",
        modal: "var(--z-modal)",
        popover: "var(--z-popover)",
        tooltip: "var(--z-tooltip)",
        corner: "var(--z-corner)",
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        normal: "var(--duration-normal)",
        slow: "var(--duration-slow)",
      },
      width: {
        sidebar: "var(--workbench-sidebar)",
        "sidebar-collapsed": "var(--workbench-sidebar-collapsed)",
      },
      colors: {
        // 语义对比度令牌，按主题在 tokens.css 中取值（见 ADR 0002 注释）
        "bc-muted": "var(--bc-muted)",
        "bc-subtle": "var(--bc-subtle)",
        "primary-ink": "var(--primary-ink)",
      },
      fontFamily: {
        heading: ["Fredoka", "Comic Neue", "sans-serif"],
        sans: ["Nunito", "Comic Neue", "sans-serif"],
        sketch: ["Caveat", "cursive"],
        mono: ["JetBrains Mono", "Menlo", "monospace"],
        comic: ["Bangers", "Impact", "sans-serif"],
      },
      boxShadow: {
        'brutal': '4px 4px 0px 0px oklch(var(--bc) / 0.3)',
        'brutal-sm': '2px 2px 0px 0px oklch(var(--bc) / 0.3)',
        'brutal-lg': '6px 6px 0px 0px oklch(var(--bc) / 0.3)',
        'brutal-hover': '6px 6px 0px 0px oklch(var(--bc) / 0.3)',
        'comic': '4px 4px 0px 0px oklch(var(--cmyk-cyan) / 0.7), 7px 7px 0px 0px oklch(var(--cmyk-magenta) / 0.5)',
        'comic-magenta': '4px 4px 0px 0px oklch(var(--cmyk-magenta) / 0.7), 7px 7px 0px 0px oklch(var(--bc) / 0.3)',
        'comic-pop': '5px 5px 0px 0px oklch(var(--cmyk-cyan) / 0.8), 9px 9px 0px 0px oklch(var(--cmyk-magenta) / 0.6)',
      },
      borderWidth: {
        '3': '3px',
      },
      backgroundImage: {
        'halftone': 'radial-gradient(circle, oklch(var(--bc) / 0.08) 1.2px, transparent 1.2px)',
        'halftone-dense': 'radial-gradient(circle, oklch(var(--bc) / 0.1) 1.4px, transparent 1.4px)',
        'halftone-accent': 'radial-gradient(circle, oklch(var(--p) / 0.16) 1.2px, transparent 1.2px)',
      },
      backgroundSize: {
        'halftone': '7px 7px',
        'halftone-dense': '5px 5px',
      },
    },
  },
  plugins: [daisyui],
  daisyui: {
    themes: [
      {
        doodle: {
          "primary": "#E8B730",
          "primary-content": "#1a1a1a",
          "secondary": "#D45E8B",
          "secondary-content": "#1a1a1a",
          "accent": "#2AA8B8",
          "accent-content": "#1a1a1a",
          "neutral": "#1E1E2E",
          "neutral-content": "#E6EDF3",
          "base-100": "#FAFAF5",
          "base-200": "#F0EFE6",
          "base-300": "#E2E0D4",
          "base-content": "#2C2C3A",
          "info": "#2AA8B8",
          "info-content": "#1a1a1a",
          "success": "#4CAF7D",
          "success-content": "#1a1a1a",
          "warning": "#E8943A",
          "warning-content": "#1a1a1a",
          "error": "#C03A3A",
          "error-content": "#ffffff",
        },
      },
      {
        "doodle-dark": {
          "primary": "#F0C050",
          "primary-content": "#1a1a1a",
          "secondary": "#E06898",
          "secondary-content": "#1a1a1a",
          "accent": "#40C0D0",
          "accent-content": "#1a1a1a",
          "neutral": "#2A2A3A",
          "neutral-content": "#D0D0E0",
          "base-100": "#16161E",
          "base-200": "#1E1E28",
          "base-300": "#28283A",
          "base-content": "#D8D8E8",
          "info": "#40C0D0",
          "info-content": "#16161E",
          "success": "#60CF90",
          "success-content": "#16161E",
          "warning": "#F0B050",
          "warning-content": "#16161E",
          "error": "#E86868",
          "error-content": "#16161E",
        },
      },
    ],
    darkTheme: "doodle-dark",
  },
} satisfies Config;

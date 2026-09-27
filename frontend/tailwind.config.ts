import type { Config } from "tailwindcss";

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
        // Owned semantic palette; values live in styles/tokens.css.
        primary: "rgb(var(--color-primary) / <alpha-value>)",
        "primary-content": "rgb(var(--color-primary-content) / <alpha-value>)",
        secondary: "rgb(var(--color-secondary) / <alpha-value>)",
        "secondary-content": "rgb(var(--color-secondary-content) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        "accent-content": "rgb(var(--color-accent-content) / <alpha-value>)",
        neutral: "rgb(var(--color-neutral) / <alpha-value>)",
        "neutral-content": "rgb(var(--color-neutral-content) / <alpha-value>)",
        "paper-100": "rgb(var(--color-paper-100) / <alpha-value>)",
        "paper-200": "rgb(var(--color-paper-200) / <alpha-value>)",
        "paper-300": "rgb(var(--color-paper-300) / <alpha-value>)",
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        info: "rgb(var(--color-info) / <alpha-value>)",
        "info-content": "rgb(var(--color-info-content) / <alpha-value>)",
        success: "rgb(var(--color-success) / <alpha-value>)",
        "success-content": "rgb(var(--color-success-content) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)",
        "warning-content": "rgb(var(--color-warning-content) / <alpha-value>)",
        error: "rgb(var(--color-error) / <alpha-value>)",
        "error-content": "rgb(var(--color-error-content) / <alpha-value>)",
        // 语义对比度令牌，按主题在 tokens.css 中取值（见 ADR 0002 注释）
        "ink-muted": "var(--ink-muted)",
        "ink-subtle": "var(--ink-subtle)",
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
        'brutal': '4px 4px 0px 0px rgb(var(--color-ink) / 0.3)',
        'brutal-sm': '2px 2px 0px 0px rgb(var(--color-ink) / 0.3)',
        'brutal-lg': '6px 6px 0px 0px rgb(var(--color-ink) / 0.3)',
        'brutal-hover': '6px 6px 0px 0px rgb(var(--color-ink) / 0.3)',
        'comic': '4px 4px 0px 0px oklch(var(--cmyk-cyan) / 0.7), 7px 7px 0px 0px oklch(var(--cmyk-magenta) / 0.5)',
        'comic-magenta': '4px 4px 0px 0px oklch(var(--cmyk-magenta) / 0.7), 7px 7px 0px 0px rgb(var(--color-ink) / 0.3)',
        'comic-pop': '5px 5px 0px 0px oklch(var(--cmyk-cyan) / 0.8), 9px 9px 0px 0px oklch(var(--cmyk-magenta) / 0.6)',
      },
      borderWidth: {
        '3': '3px',
      },
      backgroundImage: {
        'halftone': 'radial-gradient(circle, rgb(var(--color-ink) / 0.08) 1.2px, transparent 1.2px)',
        'halftone-dense': 'radial-gradient(circle, rgb(var(--color-ink) / 0.1) 1.4px, transparent 1.4px)',
        'halftone-accent': 'radial-gradient(circle, rgb(var(--color-primary) / 0.16) 1.2px, transparent 1.2px)',
      },
      backgroundSize: {
        'halftone': '7px 7px',
        'halftone-dense': '5px 5px',
      },
    },
  },
} satisfies Config;

/** 双色板和语义对比度守护，色值由 tokens.css 独立提供。 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tokensCss = readFileSync(resolve(__dirname, "./tokens.css"), "utf-8");
type Theme = "root" | "dark";

function tokenValue(theme: Theme, name: string): string {
  const split = tokensCss.indexOf('[data-theme="doodle-dark"]');
  const source = theme === "root" ? tokensCss.slice(0, split) : tokensCss.slice(split);
  const match = source.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`tokens.css 缺少 ${name}`);
  return match[1].trim();
}

function tokenColor(theme: Theme, name: string): [number, number, number] {
  const value = tokenValue(theme, name);
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
  }
  const channels = value.match(/\d+/g)?.map(Number);
  if (!channels || channels.length !== 3) throw new Error(`无效颜色令牌 ${name}: ${value}`);
  return channels as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(foreground: [number, number, number], background: [number, number, number]): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function alphaContrast(foreground: [number, number, number], alpha: number, background: [number, number, number]): number {
  const composite = foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha)) as [number, number, number];
  return contrast(composite, background);
}

function tokenAlpha(theme: Theme, name: string): number {
  const match = tokenValue(theme, name).match(/\/\s*([\d.]+)\)/);
  if (!match) throw new Error(`${name} 不包含 alpha`);
  return Number(match[1]);
}

const PAIRS = ["primary", "secondary", "accent", "neutral", "info", "success", "warning", "error"] as const;
const SURFACES = ["--color-paper-100", "--color-paper-200", "--color-paper-300"] as const;
const THEMES = [["doodle", "root"], ["doodle-dark", "dark"]] as const;

describe.each(THEMES)("主题 %s", (_name, theme) => {
  it.each(PAIRS)("%s 与其文字色对比度 ≥ 4.5:1", (key) => {
    expect(contrast(tokenColor(theme, `--color-${key}-content`), tokenColor(theme, `--color-${key}`))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES)("ink 在 %s 上对比度 ≥ 7:1", (surface) => {
    expect(contrast(tokenColor(theme, "--color-ink"), tokenColor(theme, surface))).toBeGreaterThanOrEqual(7);
  });

  it.each(SURFACES)("muted 文本在 %s 上对比度 ≥ 4.5:1", (surface) => {
    expect(alphaContrast(tokenColor(theme, "--color-ink"), tokenAlpha(theme, "--ink-muted"), tokenColor(theme, surface))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES)("subtle 文本在 %s 上对比度 ≥ 3:1", (surface) => {
    expect(alphaContrast(tokenColor(theme, "--color-ink"), tokenAlpha(theme, "--ink-subtle"), tokenColor(theme, surface))).toBeGreaterThanOrEqual(3);
  });

  it.each(SURFACES)("品牌色文字在 %s 上对比度 ≥ 4.5:1", (surface) => {
    expect(contrast(tokenColor(theme, "--primary-ink"), tokenColor(theme, surface))).toBeGreaterThanOrEqual(4.5);
  });

  it("error 文字在 paper-100 上对比度 ≥ 4.5:1", () => {
    expect(contrast(tokenColor(theme, "--color-error"), tokenColor(theme, "--color-paper-100"))).toBeGreaterThanOrEqual(4.5);
  });
});

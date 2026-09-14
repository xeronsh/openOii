/**
 * Design Contract 守卫（ADR 0002）。
 *
 * tokens.css 是 SSOT；tailwind.config.ts 把 token 映射成裸类。
 * 因此代码里**不许**再出现绕过映射的写法：
 *   text-[length:var(--text-sm)]  →  text-sm
 *   rounded-[var(--radius-md)]    →  rounded-md
 *   z-[var(--z-modal)]            →  z-modal
 *   duration-[var(--duration-fast)] → duration-fast
 * 以及不许脱离尺子：text-[11px]、z-9999、rounded-2xl、裸 hex 颜色。
 *
 * themeContrast.test.ts 管颜色对比度，这个文件管几何。
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import tailwindConfig from "../../tailwind.config";

const root = resolve(__dirname, "../..");
const sources = globSync("app/**/*.{ts,tsx}", { cwd: root })
	.filter((f) => !f.includes(".test."))
	.map((f) => ({ file: f, text: readFileSync(resolve(root, f), "utf-8") }));

const config = tailwindConfig as unknown as {
	theme: { extend: Record<string, Record<string, string> | undefined> };
};
const extend = config.theme.extend;

/** 禁止的写法 → 替换建议 */
const BANNED: Array<[RegExp, string]> = [
	[/\[(?:length:)?var\(--text-/, "用裸类 text-sm / text-2xs（已在 tailwind.config.ts 映射）"],
	[/\[var\(--radius-/, "用裸类 rounded-md / rounded-lg（已在 tailwind.config.ts 映射）"],
	[/z-\[var\(--z-/, "用裸类 z-modal / z-dropdown（已在 tailwind.config.ts 映射）"],
	[/duration-\[var\(--duration-/, "用裸类 duration-fast（已在 tailwind.config.ts 映射）"],
	[/leading-\[var\(--leading-/, "用裸类 leading-tight / leading-normal（已在 tailwind.config.ts 映射）"],
	[/\btext-\[\d+px\]/, "脱离 type scale：用 text-2xs(10) / text-xs(12)"],
	[/\bz-\[\d{3,}\]/, "脱离 z scale：tokens.css 的 --z-* 才是唯一分层来源"],
	[/\bz-[1-9]\d\b/, "脱离 z scale：用 z-dropdown / z-sticky / z-modal 等命名层"],
	[/\brounded-(?:2xl|3xl|none)\b/, "超出 --radius-* 四档：用 rounded-sm/md/lg/xl"],
	[/#[0-9a-fA-F]{6}\b/, "裸 hex：颜色只能来自 daisyUI 主题或 tokens.css 的语义令牌"],
	[/gap-\[var\(--rhythm-/, "用裸类 gap-2/3/5（= --rhythm-item/block/zone）"],
	[/\b(?:p|m|gap|space)-\[var\(--space-/, "用裸类 p-2 / gap-3（已在 tailwind.config.ts 映射）"],
	[/\bleading-(?:[0-9]|\[)/, "脱离 leading 三档：leading-tight(1.15) / snug(1.35) / normal(1.5)"],
	[/\btext-(?:default|inherit)\b/, "字体尺寸必须来自 type scale"],
];

/** alpha 阶梯：只允许 5 的倍数，防止 /8 /12 /65 /85 这类随手档 */
const ALPHA = /\b(?:border|bg|text|from|to|via|ring|outline|divide|decoration|placeholder)-[a-z0-9-]+\/(\d{1,3})\b/g;

describe("Design Contract: geometry 走 token 映射", () => {
	it.each(BANNED)("源码不含 %s", (pattern, hint) => {
		const hits = sources
			.filter(({ text }) => pattern.test(text))
			.map(({ file }) => file);
		expect(hits, `${hint}\n违规文件：\n${hits.join("\n")}`).toEqual([]);
	});
});

describe("Design Contract: 不透明度阶梯是 5 的倍数", () => {
	it("源码不含 /8 /12 /65 这类随手档", () => {
		const bad: string[] = [];
		for (const { file, text } of sources) {
			for (const m of text.matchAll(ALPHA)) {
				if (Number(m[1]) % 5 !== 0) bad.push(`${file}: ${m[0]}`);
			}
		}
		expect(bad, `超纲档位：\n${bad.join("\n")}`).toEqual([]);
	});
});

describe("Design Contract: tailwind 映射与 tokens.css 一致", () => {
	const tokens = readFileSync(resolve(root, "app/styles/tokens.css"), "utf-8");

	/** tokens.css 里 --name 的值（第一个匹配，即 :root 块） */
	function token(name: string): string {
		const m = tokens.slice(0, tokens.indexOf('[data-theme="doodle-dark"]')).match(
			new RegExp(`\\${name}:\\s*([^;]+);`),
		);
		if (!m) throw new Error(`tokens.css 缺 ${name}`);
		return m[1].trim();
	}

	it("radius 四档全部映射到 --radius-*", () => {
		const scale = extend.borderRadius as Record<string, string>;
		for (const key of ["sm", "md", "lg", "xl"] as const) {
			expect(scale[key], `borderRadius.${key}`).toBe(`var(--radius-${key})`);
		}
	});

	it("type scale 全部映射到 --text-*", () => {
		const scale = extend.fontSize as Record<string, string>;
		for (const key of ["2xs", "xs", "sm", "base", "md", "lg", "xl"] as const) {
			expect(scale[key], `fontSize.${key}`).toBe(`var(--text-${key})`);
		}
	});

	it("spacing 档位与 --space-* 同名同值（8px 栅格）", () => {
		const scale = extend.spacing as Record<string, string>;
		for (const [key, value] of Object.entries(scale)) {
			expect(value, `spacing.${key}`).toBe(`var(--space-${key})`);
			// --space-1: 0.25rem → 4px，栅格必须是 4 的整数倍
			const rem = parseFloat(token(`--space-${key}`).replace("rem", ""));
			expect(rem % 0.25, `--space-${key} = ${rem}rem 不在 4px 栅格上`).toBe(0);
		}
	});

	it("z-index 分层只来自 --z-*", () => {
		const scale = extend.zIndex as Record<string, string>;
		const declared = [...tokens.matchAll(/--(z-[a-z-]+):/g)].map((m) => m[1]);
		for (const name of declared) {
			const key = name.replace(/^z-/, "");
			expect(scale?.[key], `zIndex.${key} 未映射`).toBe(`var(--${name})`);
		}
	});

	it("每个映射的 token 都真实存在于 tokens.css", () => {
		for (const [group, scale] of Object.entries(extend)) {
			if (!scale) continue;
			for (const value of Object.values(scale)) {
				const m = /^var\((--[a-z0-9-]+)\)$/.exec(value);
				if (!m) continue;
				expect(tokens, `${group} → ${m[1]} 未定义`).toContain(`${m[1]}:`);
			}
		}
	});
});

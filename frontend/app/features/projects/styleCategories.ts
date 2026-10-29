/** Visual styles offered when a project is created (value = backend style id). */
export const STYLE_CATEGORIES = [
	{ group: "2D 动画", styles: [
		{ value: "anime", label: "日漫" },
		{ value: "shonen", label: "少年热血" },
		{ value: "slice-of-life", label: "日常治愈" },
		{ value: "manga", label: "黑白漫画" },
		{ value: "donghua", label: "国风动画" },
	] },
	{ group: "3D 风格", styles: [
		{ value: "cinematic", label: "电影质感" },
		{ value: "pixar", label: "3D 卡通" },
		{ value: "lowpoly", label: "低多边形" },
	] },
	{ group: "艺术风格", styles: [
		{ value: "watercolor", label: "水彩" },
		{ value: "sketch", label: "素描" },
		{ value: "realistic", label: "写实" },
	] },
];

/** 风格 id → 中文名；未知的自定义风格原样显示。 */
export function styleLabel(value: string | null | undefined): string | null {
	if (!value) return null;
	for (const category of STYLE_CATEGORIES) {
		const match = category.styles.find((style) => style.value === value);
		if (match) return match.label;
	}
	return value;
}

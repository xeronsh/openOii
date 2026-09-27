export function motionDuration(speed: "fast" | "normal" | "slow"): number {
	if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
		return 0;
	}
	const value = Number.parseFloat(
		getComputedStyle(document.documentElement).getPropertyValue(`--duration-${speed}`),
	);
	return Number.isFinite(value) ? value : 0;
}

import { beforeEach, describe, expect, it } from "vitest";
import { useToastStore } from "~/stores/toast.store";
import { toast } from "./toast";

describe("toast.dismiss", () => {
	beforeEach(() => useToastStore.getState().clearToasts());

	it("removes exactly the toast whose id the call returned", () => {
		const pending = toast.info({ title: "导出中", message: "正在生成" });
		toast.warning({ title: "别的提示", message: "保留" });
		expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(["导出中", "别的提示"]);
		toast.dismiss(pending);
		expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(["别的提示"]);
		toast.dismiss("toast-unknown");
		expect(useToastStore.getState().toasts).toHaveLength(1);
	});
});

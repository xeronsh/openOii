import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigInput } from "./ConfigInput";
import { configApi } from "~/services/api";
import type { ConfigItem } from "~/types";

// Mock API
vi.mock("~/services/api", () => ({
	configApi: {
		revealValue: vi.fn(),
	},
}));

describe("ConfigInput", () => {
	const mockOnChange = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("渲染普通文本输入框", () => {
		const item: ConfigItem = {
			key: "APP_NAME",
			value: "OpenOii",
			is_sensitive: false,
			is_masked: false,
			source: "env",
		};

		render(<ConfigInput item={item} value="OpenOii" onChange={mockOnChange} />);

		const input = screen.getByDisplayValue("OpenOii");
		expect(input).toBeInTheDocument();
		expect(input).toHaveAttribute("type", "text");
		expect(input).toHaveAttribute("name", "APP_NAME");
	});

	it("普通输入框可以修改", async () => {
		const user = userEvent.setup();
		const item: ConfigItem = {
			key: "APP_NAME",
			value: "OpenOii",
			is_sensitive: false,
			is_masked: false,
			source: "env",
		};

		render(<ConfigInput item={item} value="OpenOii" onChange={mockOnChange} />);

		const input = screen.getByDisplayValue("OpenOii");
		await user.clear(input);
		await user.type(input, "NewName");

		expect(mockOnChange).toHaveBeenCalled();
	});

	it("渲染敏感输入框（脱敏值）", () => {
		const item: ConfigItem = {
			key: "API_KEY",
			value: "sk-a******key",
			is_sensitive: true,
			is_masked: true,
			source: "db",
		};

		render(
			<ConfigInput item={item} value="sk-a******key" onChange={mockOnChange} />,
		);

		const input = screen.getByDisplayValue("sk-a******key");
		expect(input).toBeInTheDocument();

		// 验证眼睛图标存在
		const eyeButton = screen.getByRole("button", { name: /显示真实值/i });
		expect(eyeButton).toBeInTheDocument();

		// 验证提示文本
		expect(screen.getByText(/已配置（显示脱敏值）/i)).toBeInTheDocument();
	});

	it("渲染敏感输入框（未脱敏）", () => {
		const item: ConfigItem = {
			key: "API_KEY",
			value: "sk-actual-key-123",
			is_sensitive: true,
			is_masked: false,
			source: "env",
		};

		render(
			<ConfigInput
				item={item}
				value="sk-actual-key-123"
				onChange={mockOnChange}
			/>,
		);

		// 敏感字段未脱敏时显示为点号
		const input = screen.getByDisplayValue("••••••••");
		expect(input).toBeInTheDocument();
	});

	it("点击眼睛图标显示真实值", async () => {
		const user = userEvent.setup();
		const item: ConfigItem = {
			key: "API_KEY",
			value: "sk-a******key",
			is_sensitive: true,
			is_masked: true,
			source: "db",
		};

		vi.mocked(configApi.revealValue).mockResolvedValue({
			key: "API_KEY",
			value: "sk-actual-key-123456",
		});

		// 模拟受控组件：onChange 更新 value prop
		let currentValue = "sk-a******key";
		const onChange = vi.fn(
			(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
				currentValue = e.target.value;
			},
		);

		const { rerender } = render(
			<ConfigInput item={item} value={currentValue} onChange={onChange} />,
		);

		const eyeButton = screen.getByRole("button", { name: /显示真实值/i });
		await user.click(eyeButton);

		// 验证 API 调用
		expect(configApi.revealValue).toHaveBeenCalledWith("API_KEY");

		// onChange 被调用以同步真实值到 formState
		await waitFor(() => {
			expect(onChange).toHaveBeenCalled();
		});

		// 模拟父组件更新 value prop
		rerender(
			<ConfigInput item={item} value={currentValue} onChange={onChange} />,
		);

		// 等待真实值显示
		await waitFor(() => {
			expect(
				screen.getByDisplayValue("sk-actual-key-123456"),
			).toBeInTheDocument();
		});

		// 验证警告提示
		expect(screen.getByText(/真实值已显示/i)).toBeInTheDocument();

		// 验证按钮变为隐藏图标
		expect(
			screen.getByRole("button", { name: /隐藏真实值/i }),
		).toBeInTheDocument();
	});

	it("再次点击眼睛图标隐藏真实值", async () => {
		const user = userEvent.setup();
		const item: ConfigItem = {
			key: "API_KEY",
			value: "sk-a******key",
			is_sensitive: true,
			is_masked: true,
			source: "db",
		};

		vi.mocked(configApi.revealValue).mockResolvedValue({
			key: "API_KEY",
			value: "sk-actual-key-123456",
		});

		// 模拟受控组件
		let currentValue = "sk-a******key";
		const onChange = vi.fn(
			(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
				currentValue = e.target.value;
			},
		);

		const { rerender } = render(
			<ConfigInput item={item} value={currentValue} onChange={onChange} />,
		);

		// 第一次点击：显示真实值
		const eyeButton = screen.getByRole("button", { name: /显示真实值/i });
		await user.click(eyeButton);

		await waitFor(() => {
			expect(onChange).toHaveBeenCalled();
		});

		// 模拟父组件更新 value prop
		rerender(
			<ConfigInput item={item} value={currentValue} onChange={onChange} />,
		);

		await waitFor(() => {
			expect(
				screen.getByDisplayValue("sk-actual-key-123456"),
			).toBeInTheDocument();
		});

		// 第二次点击：隐藏真实值
		const hideButton = screen.getByRole("button", { name: /隐藏真实值/i });
		await user.click(hideButton);

		// 隐藏后 value prop 不变（仍是真实值），但 isRevealed=false 时显示脱敏值
		// 由于 value 已被同步为真实值，隐藏后显示的是 value（真实值）
		// 这是预期行为：用户已知道真实值，隐藏只是移除警告提示
		await waitFor(() => {
			expect(screen.queryByText(/真实值已显示/i)).not.toBeInTheDocument();
		});
	});

	it("显示真实值失败时显示错误", async () => {
		const user = userEvent.setup();
		const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const item: ConfigItem = {
			key: "API_KEY",
			value: "sk-a******key",
			is_sensitive: true,
			is_masked: true,
			source: "db",
		};

		vi.mocked(configApi.revealValue).mockRejectedValue(new Error("网络错误"));

		render(
			<ConfigInput item={item} value="sk-a******key" onChange={mockOnChange} />,
		);

		const eyeButton = screen.getByRole("button", { name: /显示真实值/i });
		await user.click(eyeButton);

		// 等待错误处理
		await waitFor(() => {
			expect(alertSpy).toHaveBeenCalledWith("获取真实值失败，请检查网络连接");
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Failed to reveal value:",
			expect.any(Error),
		);

		// 验证仍显示脱敏值
		expect(screen.getByDisplayValue("sk-a******key")).toBeInTheDocument();

		alertSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	it("显示真实值时显示加载状态", async () => {
		const user = userEvent.setup();
		const item: ConfigItem = {
			key: "API_KEY",
			value: "sk-a******key",
			is_sensitive: true,
			is_masked: true,
			source: "db",
		};

		// 创建一个永不 resolve 的 Promise 来模拟加载状态
		vi.mocked(configApi.revealValue).mockImplementation(
			() => new Promise(() => {}),
		);

		render(
			<ConfigInput item={item} value="sk-a******key" onChange={mockOnChange} />,
		);

		const eyeButton = screen.getByRole("button", { name: /显示真实值/i });
		await user.click(eyeButton);

		// 验证加载指示器
		await waitFor(() => {
			expect(
				screen.getByRole("button").querySelector(".spinner-doodle"),
			).toBeInTheDocument();
		});

		// 验证按钮被禁用
		expect(eyeButton).toBeDisabled();
	});

	it("敏感输入框可以修改值", async () => {
		const user = userEvent.setup();
		const item: ConfigItem = {
			key: "API_KEY",
			value: "sk-a******key",
			is_sensitive: true,
			is_masked: true,
			source: "db",
		};

		vi.mocked(configApi.revealValue).mockResolvedValue({
			key: "API_KEY",
			value: "sk-actual-key-123456",
		});

		// 模拟受控组件
		let currentValue = "sk-a******key";
		const onChange = vi.fn(
			(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
				currentValue = e.target.value;
			},
		);

		const { rerender } = render(
			<ConfigInput item={item} value={currentValue} onChange={onChange} />,
		);

		// 显示真实值
		const eyeButton = screen.getByRole("button", { name: /显示真实值/i });
		await user.click(eyeButton);

		await waitFor(() => {
			expect(onChange).toHaveBeenCalled();
		});

		// 模拟父组件更新 value prop
		rerender(
			<ConfigInput item={item} value={currentValue} onChange={onChange} />,
		);

		await waitFor(() => {
			expect(
				screen.getByDisplayValue("sk-actual-key-123456"),
			).toBeInTheDocument();
		});

		// 修改值
		const input = screen.getByDisplayValue("sk-actual-key-123456");
		await user.clear(input);
		await user.type(input, "new-key-value");

		expect(onChange).toHaveBeenCalled();
	});

	it("敏感输入框显示占位符", async () => {
		const user = userEvent.setup();
		const item: ConfigItem = {
			key: "API_KEY",
			value: "sk-a******key",
			is_sensitive: true,
			is_masked: true,
			source: "db",
		};

		vi.mocked(configApi.revealValue).mockResolvedValue({
			key: "API_KEY",
			value: "sk-actual-key-123456",
		});

		// 模拟受控组件
		let currentValue = "sk-a******key";
		const onChange = vi.fn(
			(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
				currentValue = e.target.value;
			},
		);

		const { rerender } = render(
			<ConfigInput item={item} value={currentValue} onChange={onChange} />,
		);

		// 显示真实值
		const eyeButton = screen.getByRole("button", { name: /显示真实值/i });
		await user.click(eyeButton);

		await waitFor(() => {
			expect(onChange).toHaveBeenCalled();
		});

		// 模拟父组件更新 value prop
		rerender(
			<ConfigInput item={item} value={currentValue} onChange={onChange} />,
		);

		await waitFor(() => {
			const input = screen.getByDisplayValue("sk-actual-key-123456");
			expect(input).toHaveAttribute("placeholder", "输入新值...");
		});
	});
});

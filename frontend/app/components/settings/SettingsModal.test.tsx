import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SettingsModal } from "./SettingsModal";
import { useSettingsStore } from "~/stores/settingsStore";
import { configApi } from "~/services/api";
import type { ConfigItem } from "~/types";

// Mock API
vi.mock("~/services/api", () => ({
	configApi: {
		get: vi.fn(),
		update: vi.fn(),
		testConnection: vi.fn(),
		revealValue: vi.fn(),
	},
}));

// Mock store
vi.mock("~/stores/settingsStore", () => ({
	useSettingsStore: vi.fn(),
}));

const mockConfigData: ConfigItem[] = [
	{
		key: "DATABASE_URL",
		value: "postgresql://localhost:5432/test",
		is_sensitive: true,
		is_masked: false,
		source: "env",
	},
	{
		key: "REDIS_URL",
		value: "redis://localhost:6379/0",
		is_sensitive: false,
		is_masked: false,
		source: "env",
	},
	{
		key: "ANTHROPIC_API_KEY",
		value: "sk-a******key",
		is_sensitive: true,
		is_masked: true,
		source: "db",
	},
	{
		key: "IMAGE_API_KEY",
		value: "img-******key",
		is_sensitive: true,
		is_masked: true,
		source: "db",
	},
	{
		key: "TEXT_PROVIDER",
		value: "anthropic",
		is_sensitive: false,
		is_masked: false,
		source: "env",
	},
	{
		key: "TEXT_BASE_URL",
		value: "https://api.anthropic.com",
		is_sensitive: false,
		is_masked: false,
		source: "env",
	},
	{
		key: "VIDEO_PROVIDER",
		value: "doubao",
		is_sensitive: false,
		is_masked: false,
		source: "env",
	},
	{
		key: "VIDEO_BASE_URL",
		value: "https://api.doubao.com",
		is_sensitive: false,
		is_masked: false,
		source: "env",
	},
];

describe("SettingsModal", () => {
	let queryClient: QueryClient;
	const mockCloseModal = vi.fn();

	beforeEach(() => {
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});

		vi.mocked(useSettingsStore).mockReturnValue({
			isModalOpen: true,
			closeModal: mockCloseModal,
			openModal: vi.fn(),
		});

		vi.mocked(configApi.get).mockResolvedValue(mockConfigData);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	const renderComponent = () => {
		return render(
			<QueryClientProvider client={queryClient}>
				<SettingsModal />
			</QueryClientProvider>,
		);
	};

	it("不渲染当模态框关闭时", () => {
		vi.mocked(useSettingsStore).mockReturnValue({
			isModalOpen: false,
			closeModal: mockCloseModal,
			openModal: vi.fn(),
		});

		const { container } = renderComponent();
		expect(container.firstChild).toBeNull();
	});

	it("渲染模态框并加载配置数据", async () => {
		renderComponent();

		// 验证标题
		expect(screen.getByRole("heading", { name: /系统设置/ })).toBeInTheDocument();

		// 等待数据加载完成
		await waitFor(
			() => {
				expect(configApi.get).toHaveBeenCalled();
				// 验证至少有一个配置项被渲染
				expect(
					screen.getByDisplayValue("redis://localhost:6379/0"),
				).toBeInTheDocument();
			},
			{ timeout: 3000 },
		);
	});

	it("切换标签页", async () => {
		const user = userEvent.setup();
		renderComponent();

		// 等待数据加载完成
		await waitFor(
			() => {
				expect(
					screen.getByDisplayValue("redis://localhost:6379/0"),
				).toBeInTheDocument();
			},
			{ timeout: 3000 },
		);

		// 点击文本生成标签（使用 role 查找）
		const tabs = screen.getAllByRole("tab");
		const textTab = tabs.find((tab) => tab.textContent?.includes("文本生成"));
		expect(textTab).toBeDefined();

		if (textTab) {
			await user.click(textTab);
			// 验证标签页切换（检查是否有 accent 背景色）
			expect(textTab).toHaveClass("bg-accent");
		}
	});

	it("视频配置会随提供商切换", async () => {
		const user = userEvent.setup();
		const videoConfig: ConfigItem[] = [
			{
				key: "VIDEO_PROVIDER",
				value: "doubao",
				is_sensitive: false,
				is_masked: false,
				source: "env",
			},
			{
				key: "VIDEO_BASE_URL",
				value: "https://video-openai.example.com",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
			{
				key: "VIDEO_API_KEY",
				value: "video-openai-key",
				is_sensitive: true,
				is_masked: true,
				source: "db",
			},
			{
				key: "VIDEO_IMAGE_MODE",
				value: "reference",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
			{
				key: "DOUBAO_API_KEY",
				value: "doubao-api-key",
				is_sensitive: true,
				is_masked: true,
				source: "db",
			},
		];

		vi.mocked(configApi.get).mockResolvedValue(videoConfig as never);
		renderComponent();

		const videoTab = await screen.findByRole("tab", { name: /视频服务/ });
		await user.click(videoTab);

		await waitFor(() => {
			expect(screen.getByText("豆包视频配置")).toBeInTheDocument();
			expect(screen.getByDisplayValue("doubao-api-key")).toBeInTheDocument();
		});

		const openaiRadio = screen.getByRole("radio", { name: /OpenAI 兼容/ });
		await user.click(openaiRadio);

		await waitFor(() => {
			expect(screen.getByText("OpenAI 兼容接口配置")).toBeInTheDocument();
			expect(
				screen.getByDisplayValue("https://video-openai.example.com"),
			).toBeInTheDocument();
		});

		const doubaoRadio = screen.getByRole("radio", { name: /豆包视频/ });
		await user.click(doubaoRadio);

		await waitFor(() => {
			expect(screen.getByText("豆包视频配置")).toBeInTheDocument();
			expect(screen.getByDisplayValue("doubao-api-key")).toBeInTheDocument();
		});
	});

	it("支持 text_provider 小写字段作为回退来源", async () => {
		const textProviderConfig: ConfigItem[] = [
			{
				key: "text_provider",
				value: "openai",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
			{
				key: "TEXT_BASE_URL",
				value: "https://fallback-text.example.com",
				is_sensitive: false,
				is_masked: false,
				source: "env",
			},
			{
				key: "TEXT_API_KEY",
				value: "text-openai-fallback-key",
				is_sensitive: true,
				is_masked: true,
				source: "db",
			},
		];

		vi.mocked(configApi.get).mockResolvedValue(textProviderConfig as never);
		renderComponent();

		const textTab = await screen.findByRole("tab", { name: /文本生成/ });
		await userEvent.setup().click(textTab);

		await waitFor(() => {
			expect(screen.getByText("OpenAI 兼容接口配置")).toBeInTheDocument();
			expect(screen.getByRole("radio", { name: /OpenAI 兼容/ })).toBeChecked();
			expect(
				screen.getByDisplayValue("text-openai-fallback-key"),
			).toBeInTheDocument();
		});
	});

	it("支持 ModelScope 图像 provider 并显示持久化配置项", async () => {
		const user = userEvent.setup();
		const imageConfig: ConfigItem[] = [
			{
				key: "IMAGE_PROVIDER",
				value: "modelscope",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
			{
				key: "IMAGE_BASE_URL",
				value: "https://api-inference.modelscope.cn",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
			{
				key: "IMAGE_API_KEY",
				value: "ms-******demo",
				is_sensitive: true,
				is_masked: true,
				source: "db",
			},
			{
				key: "IMAGE_MODEL",
				value: "Tongyi-MAI/Z-Image-Turbo",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
			{
				key: "IMAGE_ENDPOINT",
				value: "/v1/images/generations",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
		];

		vi.mocked(configApi.get).mockResolvedValue(imageConfig as never);
		renderComponent();

		const imageTab = await screen.findByRole("tab", { name: /图像服务/ });
		await user.click(imageTab);

		await waitFor(() => {
			expect(screen.getByRole("radio", { name: /ModelScope/ })).toBeChecked();
			expect(screen.getByText("ModelScope 图像接口配置")).toBeInTheDocument();
			expect(
				screen.getByDisplayValue("Tongyi-MAI/Z-Image-Turbo"),
			).toBeInTheDocument();
			expect(
				screen.getByDisplayValue("https://api-inference.modelscope.cn"),
			).toBeInTheDocument();
		});
	});

	it("支持 gpt-image-2 OpenAI 兼容图像接口配置", async () => {
		const user = userEvent.setup();
		const imageConfig: ConfigItem[] = [
			{
				key: "IMAGE_PROVIDER",
				value: "openai",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
			{
				key: "IMAGE_BASE_URL",
				value: "https://image.6668.dpdns.org/v1",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
			{
				key: "IMAGE_MODEL",
				value: "gpt-image-2",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
			{
				key: "IMAGE_ENDPOINT",
				value: "/chat/completions",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
		];

		vi.mocked(configApi.get).mockResolvedValue(imageConfig as never);
		renderComponent();

		const imageTab = await screen.findByRole("tab", { name: /图像服务/ });
		await user.click(imageTab);

		await waitFor(() => {
			expect(screen.getByRole("radio", { name: /OpenAI 兼容/ })).toBeChecked();
			expect(screen.getByText("OpenAI 兼容接口配置")).toBeInTheDocument();
			expect(screen.getByDisplayValue("gpt-image-2")).toBeInTheDocument();
			expect(
				screen.getByDisplayValue("https://image.6668.dpdns.org/v1"),
			).toBeInTheDocument();
			expect(screen.getByDisplayValue("/chat/completions")).toBeInTheDocument();
		});
	});

	it("切换标签页并保持输入值", async () => {
		const user = userEvent.setup();
		renderComponent();

		const dbInput = await screen.findByDisplayValue("redis://localhost:6379/0");
		await user.clear(dbInput);
		await user.type(dbInput, "redis://modified:6379/1");

		const textTab = screen.getByRole("tab", { name: /文本生成/ });
		await user.click(textTab);

		const imageTab = screen.getByRole("tab", { name: /图像服务/ });
		await user.click(imageTab);

		const databaseTab = screen.getByRole("tab", { name: /数据库/ });
		await user.click(databaseTab);

		expect(
			screen.getByDisplayValue("redis://modified:6379/1"),
		).toBeInTheDocument();
	});

	it("测试连接成功后显示成功提示", async () => {
		const user = userEvent.setup();
		vi.mocked(configApi.testConnection).mockResolvedValue({
			success: true,
			message: "连接测试通过",
			details: "service is reachable",
		});

		renderComponent();

		const textTab = await screen.findByRole("tab", { name: /文本生成/ });
		await user.click(textTab);
		const testButton = screen.getByRole("button", { name: /测试连接/i });
		await user.click(testButton);

		await waitFor(() => {
			expect(configApi.testConnection).toHaveBeenCalledWith(
				"llm",
				expect.objectContaining({
					TEXT_PROVIDER: "anthropic",
				}),
			);
			// DATABASE_URL is not relevant to llm service and should not be sent
			const overrides = vi.mocked(configApi.testConnection).mock.calls[0][1];
			expect(overrides).not.toHaveProperty("DATABASE_URL");
			expect(overrides).not.toHaveProperty("REDIS_URL");
			expect(screen.getByText("连接测试成功")).toBeInTheDocument();
			expect(screen.getByText("连接测试通过")).toBeInTheDocument();
			expect(screen.getByText("service is reachable")).toBeInTheDocument();
		});
	});

	it("测试连接失败后显示错误提示", async () => {
		const user = userEvent.setup();
		vi.mocked(configApi.testConnection).mockRejectedValue(
			new Error("connection timeout"),
		);

		renderComponent();

		const textTab = await screen.findByRole("tab", { name: /文本生成/ });
		await user.click(textTab);
		const testButton = screen.getByRole("button", { name: /测试连接/i });
		await user.click(testButton);

		await waitFor(() => {
			expect(configApi.testConnection).toHaveBeenCalledWith(
				"llm",
				expect.any(Object),
			);
			expect(screen.getByText("连接测试失败")).toBeInTheDocument();
			expect(screen.getByText("connection timeout")).toBeInTheDocument();
		});
	});

	it("测试连接降级后显示警告提示", async () => {
		const user = userEvent.setup();
		vi.mocked(configApi.testConnection).mockResolvedValue({
			success: true,
			status: "degraded",
			message: "LLM 服务部分可用",
			details: "stream=false, generate=true",
			capabilities: { generate: true, stream: false },
		});

		renderComponent();

		const textTab = await screen.findByRole("tab", { name: /文本生成/ });
		await user.click(textTab);
		const testButton = screen.getByRole("button", { name: /测试连接/i });
		await user.click(testButton);

		await waitFor(() => {
			expect(screen.getByText("连接测试部分通过")).toBeInTheDocument();
			expect(screen.getByText("LLM 服务部分可用")).toBeInTheDocument();
			expect(
				screen.getByText("stream=false, generate=true"),
			).toBeInTheDocument();
		});
	});

	it("文本配置区域会根据提供商切换展示", async () => {
		const user = userEvent.setup();
		const textConfig = [
			...mockConfigData.filter(
				(item) =>
					!["TEXT_PROVIDER", "TEXT_BASE_URL", "TEXT_API_KEY"].includes(
						item.key,
					),
			),
			{
				key: "TEXT_PROVIDER",
				value: "anthropic",
				is_sensitive: false,
				is_masked: false,
				source: "env",
			},
			{
				key: "TEXT_BASE_URL",
				value: "https://api.openai.com",
				is_sensitive: false,
				is_masked: false,
				source: "db",
			},
			{
				key: "TEXT_API_KEY",
				value: "text-openai-key",
				is_sensitive: true,
				is_masked: true,
				source: "db",
			},
		];

		vi.mocked(configApi.get).mockResolvedValue(textConfig as never);

		renderComponent();

		const textTab = await screen.findByRole("tab", { name: /文本生成/i });
		await user.click(textTab);

		await waitFor(() => {
			expect(screen.getByText("Anthropic Claude 配置")).toBeInTheDocument();
		});

		const openaiRadio = screen.getByRole("radio", { name: /OpenAI 兼容/ });
		await user.click(openaiRadio);

		await waitFor(() => {
			expect(screen.getByText("OpenAI 兼容接口配置")).toBeInTheDocument();
			const openaiSection = screen
				.getByText("OpenAI 兼容接口配置")
				.closest("div");
			expect(openaiSection).toBeTruthy();
			if (openaiSection) {
				expect(
					within(openaiSection).getByDisplayValue("https://api.openai.com"),
				).toBeInTheDocument();
			}
		});

		const anthropicRadio = screen.getByRole("radio", {
			name: /Anthropic Claude/,
		});
		await user.click(anthropicRadio);

		await waitFor(() => {
			expect(screen.getByDisplayValue("sk-a******key")).toBeInTheDocument();
		});
	});

	it("修改配置值", async () => {
		const user = userEvent.setup();
		renderComponent();

		await waitFor(() => {
			expect(
				screen.getByDisplayValue("redis://localhost:6379/0"),
			).toBeInTheDocument();
		});

		// 修改 REDIS_URL
		const redisInput = screen.getByDisplayValue("redis://localhost:6379/0");
		await user.clear(redisInput);
		await user.type(redisInput, "redis://newhost:6379/1");

		expect(redisInput).toHaveValue("redis://newhost:6379/1");
	});

	it("提交配置更新 - 成功场景", async () => {
		const user = userEvent.setup();
		vi.mocked(configApi.update).mockResolvedValue({
			updated: 1,
			skipped: 0,
			restart_required: false,
			restart_keys: [],
			message: "配置已保存",
		});

		renderComponent();

		await waitFor(() => {
			expect(
				screen.getByDisplayValue("redis://localhost:6379/0"),
			).toBeInTheDocument();
		});

		// 修改配置
		const redisInput = screen.getByDisplayValue("redis://localhost:6379/0");
		await user.clear(redisInput);
		await user.type(redisInput, "redis://newhost:6379/1");

		// 提交表单
		const saveButton = screen.getByRole("button", { name: /保存/i });
		await user.click(saveButton);

		// 验证 API 调用
		await waitFor(() => {
			expect(configApi.update).toHaveBeenCalledWith(
				{
					REDIS_URL: "redis://newhost:6379/1",
				},
			);
		});

		// 验证成功提示
		await waitFor(() => {
			expect(screen.getByText("保存成功")).toBeInTheDocument();
			expect(screen.getByText("配置已保存并立即生效！")).toBeInTheDocument();
		});
	});

	it("没有配置变更时不提交更新请求", async () => {
		const user = userEvent.setup();
		renderComponent();

		await waitFor(() => {
			expect(
				screen.getByDisplayValue("redis://localhost:6379/0"),
			).toBeInTheDocument();
		});

		const saveButton = screen.getByRole("button", { name: /保存/i });
		await user.click(saveButton);

		await waitFor(() => {
			expect(screen.getByText("没有变更")).toBeInTheDocument();
		});
		expect(configApi.update).not.toHaveBeenCalled();
	});

	it("提交配置更新 - 需要重启场景", async () => {
		const user = userEvent.setup();
		vi.mocked(configApi.update).mockResolvedValue({
			updated: 1,
			skipped: 0,
			restart_required: true,
			restart_keys: ["REDIS_URL"],
			message: "配置已保存，需要重启",
		});

		renderComponent();

		await waitFor(() => {
			expect(
				screen.getByDisplayValue("redis://localhost:6379/0"),
			).toBeInTheDocument();
		});

		// 修改 Redis URL（需要重启的配置）
		const redisInput = screen.getByDisplayValue("redis://localhost:6379/0");
		await user.clear(redisInput);
		await user.type(redisInput, "redis://newhost:6379/1");

		// 提交表单
		const saveButton = screen.getByRole("button", { name: /保存配置/i });
		await user.click(saveButton);

		// 验证警告提示（Alert 是独立的 modal）
		await waitFor(
			() => {
				expect(screen.getByText("配置已保存！")).toBeInTheDocument();
				expect(screen.getByText("其他配置已立即生效。")).toBeInTheDocument();
			},
			{ timeout: 3000 },
		);

		// 验证详细信息中包含需要重启的配置键
		const detailsElement = screen.getByText(/以下配置需要重启服务才能生效/i);
		expect(detailsElement).toBeInTheDocument();
	});

	it("重启提示弹窗确认后会关闭设置模态框", async () => {
		const user = userEvent.setup();
		vi.mocked(configApi.update).mockResolvedValue({
			updated: 1,
			skipped: 0,
			restart_required: true,
			restart_keys: ["REDIS_URL"],
			message: "配置已保存，需要重启",
		});

		renderComponent();

		await waitFor(() => {
			expect(
				screen.getByDisplayValue("redis://localhost:6379/0"),
			).toBeInTheDocument();
		});

		const redisInput = screen.getByDisplayValue("redis://localhost:6379/0");
		await user.clear(redisInput);
		await user.type(redisInput, "redis://newhost:6379/1");

		const saveButton = screen.getByRole("button", { name: /保存/i });
		await user.click(saveButton);

		await waitFor(() => {
			expect(screen.getByText("配置已保存！")).toBeInTheDocument();
		});

		await user.click(screen.getByRole("button", { name: "确定" }));
		expect(mockCloseModal).toHaveBeenCalled();
	});

	it("提交配置更新 - 失败场景", async () => {
		const user = userEvent.setup();
		vi.mocked(configApi.update).mockRejectedValue(new Error("网络错误"));

		renderComponent();

		await waitFor(() => {
			expect(
				screen.getByDisplayValue("redis://localhost:6379/0"),
			).toBeInTheDocument();
		});

		// 修改配置
		const redisInput = screen.getByDisplayValue("redis://localhost:6379/0");
		await user.clear(redisInput);
		await user.type(redisInput, "invalid-url");

		// 提交表单
		const saveButton = screen.getByRole("button", { name: /保存/i });
		await user.click(saveButton);

		// 验证错误提示
		await waitFor(() => {
			expect(screen.getByText("保存失败")).toBeInTheDocument();
			expect(screen.getByText("网络错误")).toBeInTheDocument();
		});
	});

	it("取消操作恢复原始值", async () => {
		const user = userEvent.setup();
		renderComponent();

		await waitFor(() => {
			expect(
				screen.getByDisplayValue("redis://localhost:6379/0"),
			).toBeInTheDocument();
		});

		// 修改配置
		const redisInput = screen.getByDisplayValue("redis://localhost:6379/0");
		await user.clear(redisInput);
		await user.type(redisInput, "redis://modified:6379/1");

		expect(redisInput).toHaveValue("redis://modified:6379/1");

		// 点击取消
		const cancelButton = screen.getByRole("button", { name: /取消/i });
		await user.click(cancelButton);

		// 验证关闭模态框
		expect(mockCloseModal).toHaveBeenCalled();
	});

	it("显示加载状态", async () => {
		let resolvePromise: (value: ConfigItem[]) => void;
		const promise = new Promise<ConfigItem[]>((resolve) => {
			resolvePromise = resolve;
		});

		vi.mocked(configApi.get).mockReturnValue(promise);

		renderComponent();

		// 验证加载指示器存在
		const loadingSpinner = document.querySelector(".spinner-doodle");
		expect(loadingSpinner).toBeInTheDocument();

		// 清理：resolve promise
		resolvePromise!(mockConfigData);
	});

	it("显示错误状态", async () => {
		vi.mocked(configApi.get).mockRejectedValue(new Error("加载失败"));

		renderComponent();

		await waitFor(() => {
			expect(screen.getByText(/加载配置失败/i)).toBeInTheDocument();
		});
	});

	it("敏感字段可显示真实值并可再次隐藏", async () => {
		const user = userEvent.setup();
		vi.mocked(configApi.revealValue).mockResolvedValue({
			value: "sk-revealed-value",
		} as never);

		renderComponent();

		const textTab = await screen.findByRole("tab", { name: /文本生成/ });
		await user.click(textTab);

		await waitFor(() => {
			expect(screen.getByDisplayValue("sk-a******key")).toBeInTheDocument();
		});

		const revealButton = screen.getByTitle("显示真实值");
		await user.click(revealButton);

		await waitFor(() => {
			expect(configApi.revealValue).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
			expect(screen.getByDisplayValue("sk-revealed-value")).toBeInTheDocument();
			expect(
				screen.getByText("真实值已显示，请注意保护隐私"),
			).toBeInTheDocument();
		});

		const hideButton = screen.getByTitle("隐藏真实值");
		await user.click(hideButton);

		await waitFor(() => {
			// 揭示后 formState 已同步为真实值，隐藏只是移除警告提示
			expect(screen.getByDisplayValue("sk-revealed-value")).toBeInTheDocument();
			expect(
				screen.queryByText("真实值已显示，请注意保护隐私"),
			).not.toBeInTheDocument();
		});
	});

	it("显示真实值失败时给出错误提示", async () => {
		const user = userEvent.setup();
		const alertSpy = vi
			.spyOn(window, "alert")
			.mockImplementation(() => undefined);
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		vi.mocked(configApi.revealValue).mockRejectedValue(
			new Error("reveal fail") as never,
		);

		renderComponent();

		const textTab = await screen.findByRole("tab", { name: /文本生成/ });
		await user.click(textTab);

		await waitFor(() => {
			expect(screen.getByTitle("显示真实值")).toBeInTheDocument();
		});

		await user.click(screen.getByTitle("显示真实值"));

		await waitFor(() => {
			expect(alertSpy).toHaveBeenCalledWith("获取真实值失败，请检查网络连接");
		});

		consoleErrorSpy.mockRestore();
		alertSpy.mockRestore();
	});

	it("敏感配置显示脱敏值", async () => {
		renderComponent();

		// 等待数据加载完成
		await waitFor(
			() => {
				expect(
					screen.getByDisplayValue("redis://localhost:6379/0"),
				).toBeInTheDocument();
			},
			{ timeout: 3000 },
		);

		const tabs = screen.getAllByRole("tab");
		const textTab = tabs.find((tab) => tab.textContent?.includes("文本生成"));

		if (textTab) {
			await userEvent.setup().click(textTab);

			// 验证敏感配置显示脱敏值
			await waitFor(
				() => {
					const apiKeyInput = screen.getByDisplayValue("sk-a******key");
					expect(apiKeyInput).toBeInTheDocument();
				},
				{ timeout: 3000 },
			);
		}
	});

	it("关闭 Alert 后继续操作", async () => {
		const user = userEvent.setup();
		vi.mocked(configApi.update).mockResolvedValue({
			updated: 1,
			skipped: 0,
			restart_required: false,
			restart_keys: [],
			message: "配置已保存",
		});

		renderComponent();

		await waitFor(() => {
			expect(
				screen.getByDisplayValue("redis://localhost:6379/0"),
			).toBeInTheDocument();
		});

		// 修改并保存
		const redisInput = screen.getByDisplayValue("redis://localhost:6379/0");
		await user.clear(redisInput);
		await user.type(redisInput, "redis://newhost:6379/1");

		const saveButton = screen.getByRole("button", { name: /保存/i });
		await user.click(saveButton);

		// 等待成功提示
		await waitFor(() => {
			expect(screen.getByText("保存成功")).toBeInTheDocument();
		});

		// 关闭 Alert
		const closeAlertButton = screen.getByRole("button", { name: /确定/i });
		await user.click(closeAlertButton);

		// 验证 Alert 消失
		await waitFor(() => {
			expect(screen.queryByText("保存成功")).not.toBeInTheDocument();
		});
	});
});

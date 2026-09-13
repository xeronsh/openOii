import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSettingsStore } from "~/stores/settingsStore";
import { configApi } from "~/services/api";
import type { ConfigItem, ConfigValue } from "~/types";
import { ConfigInput } from "./ConfigInput";
import { groupConfigs } from "~/utils/configGroups";
import {
	XMarkIcon,
	Cog6ToothIcon,
	InformationCircleIcon,
	CircleStackIcon,
	SparklesIcon,
	PhotoIcon,
	VideoCameraIcon,
	WrenchScrewdriverIcon,
	CheckCircleIcon,
	ExclamationCircleIcon,
} from "@heroicons/react/24/outline";

type AlertType = "success" | "error" | "warning";

interface AlertState {
	show: boolean;
	type: AlertType;
	title: string;
	message: string;
	details?: string;
}

export function SettingsModal() {
	const { isModalOpen, closeModal } = useSettingsStore();
	const queryClient = useQueryClient();
	const [formState, setFormState] = useState<Record<string, ConfigValue>>({});
	const [initialFormState, setInitialFormState] = useState<
		Record<string, ConfigValue>
	>({});
	const [activeTab, setActiveTab] = useState("database");
	const [isTestingConnection, setIsTestingConnection] = useState(false);
	const [alertState, setAlertState] = useState<AlertState>({
		show: false,
		type: "success",
		title: "",
		message: "",
	});

	const {
		data: config,
		isLoading,
		isError,
	} = useQuery({
		queryKey: ["config"],
		queryFn: configApi.get,
		enabled: isModalOpen,
	});

	useEffect(() => {
		if (config) {
			const initialState = config.reduce(
				(acc, item) => {
					acc[item.key] = item.value;
					return acc;
				},
				{} as Record<string, ConfigValue>,
			);
			setFormState(initialState);
			setInitialFormState(initialState);
		}
	}, [config]);

	// 切换标签页
	const handleTabChange = (tab: string) => {
		setActiveTab(tab);
	};

	const updateMutation = useMutation({
		mutationFn: (newConfig: Record<string, ConfigValue>) =>
			configApi.update(newConfig),
		onSuccess: (data, submittedConfig) => {
			queryClient.invalidateQueries({ queryKey: ["config"] });
			setInitialFormState((prev) => ({ ...prev, ...submittedConfig }));
			// 不要立即关闭模态框，等用户点击确定后再关闭

			// 根据后端返回判断是否需要重启
			if (data?.restart_required) {
				const keys = data.restart_keys?.join(", ") || "";
				setAlertState({
					show: true,
					type: "warning",
					title: "配置已保存！",
					message: "其他配置已立即生效。",
					details: `以下配置需要重启服务才能生效：\n${keys}`,
				});
			} else {
				setAlertState({
					show: true,
					type: "success",
					title: "保存成功",
					message: "配置已保存并立即生效！",
				});
			}
		},
		onError: (error) => {
			setAlertState({
				show: true,
				type: "error",
				title: "保存失败",
				message: error.message,
			});
		},
	});

	const handleInputChange = (
		e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
	) => {
		const { name, value } = e.target;
		setFormState((prevState) => ({ ...prevState, [name]: value }));
	};

	const getTestConnectionService = () => {
		if (activeTab === "text") {
			return "llm";
		}

		if (activeTab === "image") {
			return "image";
		}

		if (activeTab === "video") {
			return "video";
		}

		return null;
	};

	const handleTestConnection = async () => {
		const service = getTestConnectionService();
		if (!service) {
			return;
		}

		// Only send overrides for fields relevant to the current service.
		// The backend rejects non-whitelisted override keys with 400.
		const servicePrefixes: Record<string, string[]> = {
			llm: ["text_", "anthropic_", "fake_text_"],
			image: ["image_", "fake_image_", "enable_image_to_image"],
			video: [
				"video_",
				"doubao_",
				"fake_video_",
				"enable_image_to_video",
				"video_image_mode",
				"video_inline_local_images",
			],
		};

		const prefixes = servicePrefixes[service];
		const relevantEntries = Object.entries(formState).filter(([key]) => {
			const lower = key.toLowerCase();
			return prefixes.some((p) => lower.startsWith(p) || lower === p);
		});

		const normalizedFormState = Object.fromEntries(
			relevantEntries
				.map(([key, value]) => [key, value === null ? null : String(value)] as const)
				.filter(([key, value]) => {
					// Empty inputs in the test-connection form mean "use the current
					// effective backend value". Sending an empty string would override
					// env/default values and can make fake fixture probes fail.
					if (value !== "") return true;
					const lower = key.toLowerCase();
					return lower.endsWith("_provider") || lower.startsWith("enable_");
				}),
		) as Record<string, string | null>;

		setIsTestingConnection(true);
		try {
			const result = await configApi.testConnection(
				service,
				normalizedFormState,
			);
			const alertType =
				result.status === "degraded"
					? "warning"
					: result.success
						? "success"
						: "error";
			setAlertState({
				show: true,
				type: alertType,
				title:
					result.status === "degraded"
						? "连接测试部分通过"
						: result.success
							? "连接测试成功"
							: "连接测试失败",
				message: result.message,
				details: result.details || undefined,
			});
		} catch (error) {
			setAlertState({
				show: true,
				type: "error",
				title: "连接测试失败",
				message: error instanceof Error ? error.message : "连接测试失败",
			});
		} finally {
			setIsTestingConnection(false);
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const changedConfig = Object.fromEntries(
			Object.entries(formState).filter(([key, value]) => {
				const initialValue = initialFormState[key];
				return String(value ?? "") !== String(initialValue ?? "");
			}),
		);

		if (Object.keys(changedConfig).length === 0) {
			setAlertState({
				show: true,
				type: "success",
				title: "没有变更",
				message: "当前配置已是最新。",
			});
			return;
		}

		updateMutation.mutate(changedConfig);
	};

	const handleCancel = () => {
		if (config) {
			const initialState = config.reduce(
				(acc, item) => {
					acc[item.key] = item.value;
					return acc;
				},
				{} as Record<string, ConfigValue>,
			);
			setFormState(initialState);
		}
		closeModal();
	};

	if (!isModalOpen) {
		return null;
	}

	const sections = config ? groupConfigs(config) : [];

	// 标签页配置
	const tabConfig: Record<
		string,
		{ icon: React.ReactNode; title: string; desc: string }
	> = {
		basic: {
			icon: <WrenchScrewdriverIcon className="w-4 h-4" />,
			title: "基础",
			desc: "应用名称、环境、日志级别等基础配置",
		},
		database: {
			icon: <CircleStackIcon className="w-4 h-4" />,
			title: "数据库",
			desc: "数据库和 Redis 连接配置",
		},
		text: {
			icon: <SparklesIcon className="w-4 h-4" />,
			title: "文本生成",
			desc: "文本生成服务配置，支持 Anthropic、OpenAI 兼容接口和 Fake 本地测试",
		},
		image: {
			icon: <PhotoIcon className="w-4 h-4" />,
			title: "图像服务",
			desc: "图像生成服务配置，默认使用 ModelScope Z-Image-Turbo，也支持 OpenAI 兼容接口和 Fake 本地测试",
		},
		video: {
			icon: <VideoCameraIcon className="w-4 h-4" />,
			title: "视频服务",
			desc: "视频生成服务配置，支持 OpenAI 兼容接口、豆包和 Fake 本地测试",
		},
	};

	const activeSection = sections.find((s) => s.key === activeTab);

	// 获取当前文本服务提供商
	const getTextProvider = () => {
		return (formState["TEXT_PROVIDER"] ||
			formState["text_provider"] ||
			"anthropic") as string;
	};

	// 获取当前视频服务提供商
	const getVideoProvider = () => {
		return (formState["VIDEO_PROVIDER"] ||
			formState["video_provider"] ||
			"openai") as string;
	};

	// 获取当前图像服务提供商
	const getImageProvider = () => {
		return (formState["IMAGE_PROVIDER"] ||
			formState["image_provider"] ||
			"modelscope") as string;
	};

	// 渲染单个配置项
	const renderConfigItem = (item: ConfigItem) => (
		<div
			key={item.key}
			className="rounded-md border-2 border-base-content/15 bg-base-200/70 p-2.5"
		>
			<div className="mb-1.5 flex flex-wrap items-center gap-1.5">
				<span className="font-mono text-xs font-bold">
					{item.key.toUpperCase()}
				</span>
				{item.is_sensitive && (
					<span className="badge badge-warning badge-xs">敏感</span>
				)}
				{item.source === "env" && (
					<span className="badge badge-info badge-xs">仅.env</span>
				)}
			</div>
			<ConfigInput
				item={item}
				value={String(formState[item.key] ?? "")}
				onChange={handleInputChange}
			/>
			<p className="mt-1.5 text-2xs text-bc-muted">
				{getConfigDescription(item.key)}
			</p>
		</div>
	);

	// 渲染文本服务配置（特殊处理）
	const renderTextSection = () => {
		if (!activeSection || activeTab !== "text") return null;

		const textProvider = getTextProvider();

		// 分离配置项
		const providerItem = activeSection.items.find(
			(i) => i.key.toLowerCase() === "text_provider",
		);
		const anthropicItems = activeSection.items.filter((i) =>
			i.key.toLowerCase().startsWith("anthropic_"),
		);
		const openaiItems = activeSection.items.filter(
			(i) =>
				i.key.toLowerCase().startsWith("text_") &&
				i.key.toLowerCase() !== "text_provider",
		);

		const providerCard = (value: string, title: string, desc: string) => (
			<label
				className={`
          flex flex-1 cursor-pointer items-center gap-2 rounded-md border-2 p-2.5 transition-all
          ${
						textProvider === value
							? "border-accent bg-accent/10"
							: "border-base-content/20 hover:bg-base-300"
					}
        `}
			>
				<input
					type="radio"
					name="TEXT_PROVIDER"
					value={value}
					checked={textProvider === value}
					onChange={handleInputChange}
					className="radio radio-accent radio-sm"
				/>
				<div className="min-w-0">
					<div className="text-sm font-bold">{title}</div>
					<div className="text-2xs text-bc-muted">
						{desc}
					</div>
				</div>
			</label>
		);

		return (
			<div className="space-y-3">
				<div className="flex items-start gap-1.5 rounded-md border border-info/30 bg-info/10 px-2.5 py-1.5 text-xs text-info">
					<InformationCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<span>{tabConfig[activeTab]?.desc}</span>
				</div>

				{providerItem && (
					<div className="rounded-md border-2 border-base-content/15 bg-base-200/70 p-2.5">
						<div className="mb-2 flex items-center gap-1.5">
							<span className="font-mono text-xs font-bold">
								TEXT_PROVIDER
							</span>
							<span className="badge badge-primary badge-xs">必选</span>
						</div>
						<div className="flex flex-col gap-2 lg:flex-row">
							{providerCard("anthropic", "Anthropic Claude", "Anthropic 兼容接口，推荐使用")}
							{providerCard("openai", "OpenAI 兼容", "支持任何 OpenAI 兼容接口")}
							{providerCard("fake", "Fake 本地测试", "不调用外部文本 API，避免测试扣费")}
						</div>
					</div>
				)}

				{textProvider === "anthropic" && anthropicItems.length > 0 && (
					<div className="space-y-2">
						<h4 className="m-0 flex items-center gap-1.5 text-xs font-bold text-accent">
							<SparklesIcon className="h-3.5 w-3.5" />
							Anthropic Claude 配置
						</h4>
						<div className="space-y-2 rounded-r-md bg-accent/5 py-1.5 pl-2.5">
							{anthropicItems.map(renderConfigItem)}
						</div>
					</div>
				)}

				{textProvider === "openai" && openaiItems.length > 0 && (
					<div className="space-y-2">
						<h4 className="m-0 flex items-center gap-1.5 text-xs font-bold text-accent">
							<SparklesIcon className="h-3.5 w-3.5" />
							OpenAI 兼容接口配置
						</h4>
						<div className="space-y-2 rounded-r-md bg-accent/5 py-1.5 pl-2.5">
							{openaiItems.map(renderConfigItem)}
						</div>
					</div>
				)}

				{textProvider === "fake" && (
					<div className="space-y-2">
						<h4 className="m-0 flex items-center gap-1.5 text-xs font-bold text-accent">
							<SparklesIcon className="h-3.5 w-3.5" />
							Fake 本地测试配置
						</h4>
						<div className="space-y-2 rounded-r-md bg-accent/5 py-1.5 pl-2.5">
							{activeSection.items
								.filter((i) => i.key.toLowerCase().startsWith("fake_text_"))
								.map(renderConfigItem)}
							<p className="m-0 px-1 text-2xs text-bc-muted">
								启用后生成链路不会调用外部文本生成 API。
							</p>
						</div>
					</div>
				)}
			</div>
		);
	};

	// 渲染图像服务配置（支持 fake 本地测试）
	const renderImageSection = () => {
		if (!activeSection || activeTab !== "image") return null;

		const imageProvider = getImageProvider();
		const providerItem = activeSection.items.find(
			(i) => i.key.toLowerCase() === "image_provider",
		);
		const commonItems = activeSection.items.filter(
			(i) => i.key.toLowerCase() === "enable_image_to_image",
		);
		const imageApiItems = activeSection.items.filter(
			(i) =>
				i.key.toLowerCase().startsWith("image_") &&
				i.key.toLowerCase() !== "image_provider",
		);
		const fakeItems = activeSection.items.filter((i) =>
			i.key.toLowerCase().startsWith("fake_image_"),
		);

		const providerCard = (value: string, title: string, desc: string) => (
			<label
				className={`
          flex cursor-pointer items-center gap-2 rounded-md border-2 p-2.5 transition-all
          ${
						imageProvider === value
							? "border-accent bg-accent/10"
							: "border-base-content/20 hover:bg-base-300"
					}
        `}
			>
				<input
					type="radio"
					name="IMAGE_PROVIDER"
					value={value}
					checked={imageProvider === value}
					onChange={handleInputChange}
					className="radio radio-accent radio-sm"
				/>
				<div className="min-w-0">
					<div className="text-sm font-bold">{title}</div>
					<div className="text-2xs text-bc-muted">
						{desc}
					</div>
				</div>
			</label>
		);

		return (
			<div className="space-y-3">
				<div className="flex items-start gap-1.5 rounded-md border border-info/30 bg-info/10 px-2.5 py-1.5 text-xs text-info">
					<InformationCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<span>{tabConfig[activeTab]?.desc}</span>
				</div>

				{providerItem && (
					<div className="rounded-md border-2 border-base-content/15 bg-base-200/70 p-2.5">
						<div className="mb-2 flex items-center gap-1.5">
							<span className="font-mono text-xs font-bold">
								IMAGE_PROVIDER
							</span>
							<span className="badge badge-primary badge-xs">必选</span>
						</div>
						<div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
							{providerCard("openai", "OpenAI 兼容", "可用于 gpt-image-2 等兼容接口")}
							{providerCard("modelscope", "ModelScope", "异步图片任务，支持 Z-Image-Turbo")}
							{providerCard("fake", "Fake 本地测试", "返回本地占位图，不调用外部图像 API")}
						</div>
					</div>
				)}

				{(imageProvider === "modelscope" || imageProvider === "openai") &&
					imageApiItems.length > 0 && (
					<div className="space-y-2">
						<h4 className="m-0 flex items-center gap-1.5 text-xs font-bold text-accent">
							<PhotoIcon className="h-3.5 w-3.5" />
							{imageProvider === "modelscope"
								? "ModelScope 图像接口配置"
								: "OpenAI 兼容接口配置"}
						</h4>
						<div className="space-y-2 rounded-r-md bg-accent/5 py-1.5 pl-2.5">
							{imageApiItems.map(renderConfigItem)}
						</div>
					</div>
				)}

				{imageProvider === "fake" && (
					<div className="space-y-2">
						<h4 className="m-0 flex items-center gap-1.5 text-xs font-bold text-accent">
							<PhotoIcon className="h-3.5 w-3.5" />
							Fake 本地测试配置
						</h4>
						<div className="space-y-2 rounded-r-md bg-accent/5 py-1.5 pl-2.5">
							{fakeItems.map(renderConfigItem)}
							<p className="m-0 px-1 text-2xs text-bc-muted">
								未配置固定 URL 时会返回内置 SVG 占位图。
							</p>
						</div>
					</div>
				)}

				{commonItems.length > 0 && (
					<div className="space-y-2">
						<h4 className="m-0 flex items-center gap-1.5 text-xs font-bold text-bc-muted">
							<WrenchScrewdriverIcon className="h-3.5 w-3.5" />
							通用配置
						</h4>
						<div className="space-y-2 rounded-r-md bg-base-300/30 py-1.5 pl-2.5">
							{commonItems.map(renderConfigItem)}
						</div>
					</div>
				)}
			</div>
		);
	};

	// 渲染视频服务配置（特殊处理）
	const renderVideoSection = () => {
		if (!activeSection || activeTab !== "video") return null;

		const videoProvider = getVideoProvider();

		// 分离配置项
		const providerItem = activeSection.items.find(
			(i) => i.key.toLowerCase() === "video_provider",
		);
		const commonItems = activeSection.items.filter((i) =>
			[
				"video_image_mode",
				"enable_image_to_video",
				"video_inline_local_images",
			].includes(i.key.toLowerCase()),
		);
		const openaiItems = activeSection.items.filter(
			(i) =>
				i.key.toLowerCase().startsWith("video_") &&
				![
					"video_provider",
					"video_image_mode",
					"enable_image_to_video",
					"video_inline_local_images",
				].includes(i.key.toLowerCase()),
		);
		const doubaoItems = activeSection.items.filter((i) =>
			i.key.toLowerCase().startsWith("doubao_"),
		);
		const fakeItems = activeSection.items.filter((i) =>
			i.key.toLowerCase().startsWith("fake_video_"),
		);

		const providerCard = (value: string, title: string, desc: string) => (
			<label
				className={`
          flex flex-1 cursor-pointer items-center gap-2 rounded-md border-2 p-2.5 transition-all
          ${
						videoProvider === value
							? "border-accent bg-accent/10"
							: "border-base-content/20 hover:bg-base-300"
					}
        `}
			>
				<input
					type="radio"
					name="VIDEO_PROVIDER"
					value={value}
					checked={videoProvider === value}
					onChange={handleInputChange}
					className="radio radio-accent radio-sm"
				/>
				<div className="min-w-0">
					<div className="text-sm font-bold">{title}</div>
					<div className="text-2xs text-bc-muted">
						{desc}
					</div>
				</div>
			</label>
		);

		return (
			<div className="space-y-3">
				<div className="flex items-start gap-1.5 rounded-md border border-info/30 bg-info/10 px-2.5 py-1.5 text-xs text-info">
					<InformationCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<span>{tabConfig[activeTab]?.desc}</span>
				</div>

				{providerItem && (
					<div className="rounded-md border-2 border-base-content/15 bg-base-200/70 p-2.5">
						<div className="mb-2 flex items-center gap-1.5">
							<span className="font-mono text-xs font-bold">
								VIDEO_PROVIDER
							</span>
							<span className="badge badge-primary badge-xs">必选</span>
						</div>
						<div className="flex flex-col gap-2 lg:flex-row">
							{providerCard("doubao", "豆包视频", "火山引擎 Ark API，国内推荐")}
							{providerCard("openai", "OpenAI 兼容", "支持任何 OpenAI 兼容接口")}
							{providerCard("fake", "Fake 本地测试", "使用本地视频素材，不调用外部视频 API")}
						</div>
					</div>
				)}

				{videoProvider === "doubao" && doubaoItems.length > 0 && (
					<div className="space-y-2">
						<h4 className="m-0 flex items-center gap-1.5 text-xs font-bold text-accent">
							<VideoCameraIcon className="h-3.5 w-3.5" />
							豆包视频配置
						</h4>
						<div className="space-y-2 rounded-r-md bg-accent/5 py-1.5 pl-2.5">
							{doubaoItems.map(renderConfigItem)}
						</div>
					</div>
				)}

				{videoProvider === "openai" && openaiItems.length > 0 && (
					<div className="space-y-2">
						<h4 className="m-0 flex items-center gap-1.5 text-xs font-bold text-accent">
							<VideoCameraIcon className="h-3.5 w-3.5" />
							OpenAI 兼容接口配置
						</h4>
						<div className="space-y-2 rounded-r-md bg-accent/5 py-1.5 pl-2.5">
							{openaiItems.map(renderConfigItem)}
						</div>
					</div>
				)}

				{videoProvider === "fake" && fakeItems.length > 0 && (
					<div className="space-y-2">
						<h4 className="m-0 flex items-center gap-1.5 text-xs font-bold text-accent">
							<VideoCameraIcon className="h-3.5 w-3.5" />
							Fake 本地测试配置
						</h4>
						<div className="space-y-2 rounded-r-md bg-accent/5 py-1.5 pl-2.5">
							{fakeItems.map(renderConfigItem)}
						</div>
					</div>
				)}

				{commonItems.length > 0 && (
					<div className="space-y-2">
						<h4 className="m-0 flex items-center gap-1.5 text-xs font-bold text-bc-muted">
							<WrenchScrewdriverIcon className="h-3.5 w-3.5" />
							通用配置
						</h4>
						<div className="space-y-2 rounded-r-md bg-base-300/30 py-1.5 pl-2.5">
							{commonItems.map(renderConfigItem)}
						</div>
					</div>
				)}
			</div>
		);
	};

	// 渲染普通配置项列表
	const renderNormalSection = () => {
		if (
			!activeSection ||
			activeTab === "video" ||
			activeTab === "text" ||
			activeTab === "image"
		)
			return null;

		return (
			<div className="space-y-3">
				<div className="flex items-start gap-1.5 rounded-md border border-info/30 bg-info/10 px-2.5 py-1.5 text-xs text-info">
					<InformationCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<span>{tabConfig[activeTab]?.desc}</span>
				</div>

				<div className="space-y-2">
					{activeSection.items.map(renderConfigItem)}
				</div>

				{activeSection.items.length === 0 && (
					<div className="py-8 text-center text-xs text-bc-muted">
						<InformationCircleIcon className="mx-auto mb-1.5 h-8 w-8 opacity-50" />
						<p className="m-0">此分类暂无配置项</p>
					</div>
				)}
			</div>
		);
	};

	return (
		<div
			className="modal modal-open"
			role="dialog"
			aria-modal="true"
			aria-labelledby="settings-modal-title"
		>
			<div className="modal-box flex max-h-[88vh] w-11/12 max-w-5xl flex-col border-2 border-base-content/20 bg-base-100 p-0 shadow-brutal-sm">
				<div className="flex shrink-0 items-center justify-between border-b-2 border-base-content/15 bg-base-200 px-3 py-2 sm:px-4">
					<h3
						id="settings-modal-title"
						className="flex items-center gap-1.5 font-heading text-md font-bold"
					>
						<Cog6ToothIcon className="h-5 w-5 text-accent" />
						环境变量配置管理
					</h3>
					<button
						type="button"
						onClick={handleCancel}
						className="btn btn-ghost btn-circle touch-target-dense h-8 min-h-8 w-8"
						aria-label="关闭设置"
						title="关闭设置"
					>
						<XMarkIcon className="h-4 w-4" />
					</button>
				</div>

				{isLoading && (
					<div className="flex items-center justify-center p-8">
						<span className="loading loading-spinner loading-md" />
					</div>
				)}

				{isError && (
					<div className="p-3">
						<div
							role="alert"
							className="alert alert-error border-2 border-base-content/20 py-2 text-sm"
						>
							<ExclamationCircleIcon className="h-5 w-5" />
							<span>加载配置失败，请检查后端服务是否正常运行。</span>
						</div>
					</div>
				)}

				{config && (
					<form
						onSubmit={handleSubmit}
						className="flex min-h-0 flex-1 flex-col"
					>
						<div className="shrink-0 border-b-2 border-base-content/15 bg-base-100 px-3 py-2">
							<div role="tablist" className="flex flex-wrap gap-1.5">
								{sections.map((section) => {
									const cfg = tabConfig[section.key];
									const isActive = activeTab === section.key;
									return (
										<button
											key={section.key}
											type="button"
											role="tab"
											aria-selected={isActive}
											onClick={() => handleTabChange(section.key)}
											className={`
                        flex h-8 items-center gap-1.5 rounded-md px-2.5
                        text-xs font-medium
                        border-2 border-base-content/20 transition-all
                        ${
													isActive
														? "bg-accent text-accent-content shadow-brutal-sm"
														: "bg-base-200 hover:bg-base-300"
												}
                      `}
										>
											{cfg?.icon}
											<span>{cfg?.title || section.title}</span>
											<span
												className={`
                        rounded px-1 py-0.5 text-2xs tabular-nums
                        ${isActive ? "bg-accent-content/20" : "bg-base-300"}
                      `}
											>
												{section.items.length}
											</span>
										</button>
									);
								})}
							</div>
						</div>

						<div className="flex-1 overflow-y-auto p-3 sm:p-4">
							{activeTab === "text"
								? renderTextSection()
								: activeTab === "image"
									? renderImageSection()
									: activeTab === "video"
										? renderVideoSection()
										: renderNormalSection()}
						</div>

						<div className="flex shrink-0 flex-wrap items-center gap-2 border-t-2 border-base-content/15 bg-base-200 px-3 py-2 sm:px-4">
							<div className="flex min-w-0 flex-1 items-center gap-1.5 text-2xs text-info">
								<InformationCircleIcon className="h-4 w-4 shrink-0" />
								<span className="truncate">
									大部分配置保存后立即生效，数据库/Redis 配置需重启
								</span>
							</div>

							<button
								type="button"
								onClick={handleCancel}
								className="btn h-8 min-h-8 border-2 border-base-content/20 px-3 text-xs"
							>
								取消
							</button>

							<button
								type="submit"
								className="btn btn-primary h-8 min-h-8 border-2 border-base-content/20 px-3 text-xs"
								disabled={updateMutation.isPending}
							>
								{updateMutation.isPending && (
									<span className="loading loading-spinner loading-xs" />
								)}
								保存配置
							</button>
							<button
								type="button"
								className="btn btn-outline h-8 min-h-8 border-2 border-base-content/20 px-3 text-xs"
								onClick={handleTestConnection}
								disabled={
									updateMutation.isPending ||
									isTestingConnection ||
									!getTestConnectionService()
								}
							>
								{isTestingConnection && (
									<span className="loading loading-spinner loading-xs" />
								)}
								测试连接
							</button>
						</div>
					</form>
				)}
			</div>

			{alertState.show && (
				<div className="modal modal-open">
					<div className="modal-box max-w-md border-2 border-base-content/20 p-4 shadow-brutal-sm">
						<div className="flex items-start gap-2.5">
							<div
								className={`shrink-0 ${
									alertState.type === "success"
										? "text-success"
										: alertState.type === "error"
											? "text-error"
											: "text-warning"
								}`}
							>
								{alertState.type === "success" ? (
									<CheckCircleIcon className="h-6 w-6" />
								) : (
									<ExclamationCircleIcon className="h-6 w-6" />
								)}
							</div>

							<div className="min-w-0 flex-1">
								<h3 className="mb-1 font-heading text-md font-bold">
									{alertState.title}
								</h3>
								<p className="m-0 text-sm text-base-content/80">
									{alertState.message}
								</p>
								{alertState.details && (
									<div className="mt-2 rounded-md border-2 border-base-content/15 bg-base-200 p-2">
										<p className="m-0 whitespace-pre-line text-xs">
											{alertState.details}
										</p>
									</div>
								)}
							</div>
						</div>

						<div className="modal-action mt-3">
							<button
								type="button"
								onClick={() => {
									setAlertState({ ...alertState, show: false });
									closeModal();
								}}
								className="btn btn-primary h-8 min-h-8 border-2 border-base-content/20 px-3 text-xs"
							>
								确定
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

// 配置项详细说明
function getConfigDescription(key: string): string {
	const descriptions: Record<string, string> = {
		// 基础设置
		APP_NAME: "应用名称，用于日志和服务标识",
		ENVIRONMENT: "运行环境：dev（开发）/ staging（预发布）/ prod（生产）",
		LOG_LEVEL: "日志级别：DEBUG / INFO / WARNING / ERROR",
		API_V1_PREFIX: "API 路由前缀，默认 /api/v1",
		CORS_ORIGINS: '跨域配置，JSON 数组格式，如 ["http://localhost:3000"]',

		// 数据库
		DATABASE_URL: "PostgreSQL 数据库连接字符串（asyncpg 协议）",
		DB_ECHO: "是否在控制台打印 SQL 语句（调试用）",
		REDIS_URL: "Redis 连接字符串，用于跨进程信号共享",

		// LLM 服务
		ANTHROPIC_API_KEY: "Anthropic 官方 API 密钥",
		ANTHROPIC_AUTH_TOKEN: "中转站 Token（国内推荐使用）",
		ANTHROPIC_BASE_URL: "API 基础地址（官方或中转站地址）",
		ANTHROPIC_MODEL: "Claude 模型名称，如 claude-sonnet-4-5-20250929",

		// 文本生成服务
		TEXT_PROVIDER:
			"文本生成服务提供商：anthropic（Claude）/ openai（OpenAI 兼容）/ fake（本地测试，不调用外部 API）",
		FAKE_TEXT_RESPONSE: "Fake 文本 Provider 固定返回内容（可选）",
		TEXT_BASE_URL: "文本生成服务地址（OpenAI 兼容接口）",
		TEXT_API_KEY: "文本生成 API 密钥（OpenAI 兼容）",
		TEXT_MODEL: "文本生成模型名称（OpenAI 兼容），如 deepseek-v4-flash",
		TEXT_ENDPOINT: "文本生成 API 端点路径（OpenAI 兼容）",
		TEXT_ENABLE_THINKING:
			"是否向支持推理开关的文本模型显式传递 thinking 配置；留空表示由模型/服务默认决定。",

		// 图像服务
		IMAGE_PROVIDER:
			"图像生成服务提供商：modelscope（ModelScope 异步图片任务）/ openai（OpenAI 兼容）/ fake（本地测试，不调用外部 API）",
		IMAGE_BASE_URL:
			"图像生成服务地址；ModelScope 使用 https://api-inference.modelscope.cn，gpt-image-2 使用 https://image.6668.dpdns.org/v1",
		IMAGE_API_KEY: "图像生成 API 密钥",
		IMAGE_MODEL: "图像生成模型名称，如 gpt-image-2 或 Tongyi-MAI/Z-Image-Turbo",
		IMAGE_ENDPOINT:
			"图像生成 API 端点路径；gpt-image-2 使用 /chat/completions，ModelScope 使用 /v1/images/generations",
		ENABLE_IMAGE_TO_IMAGE: "是否启用图生图（I2I）功能",
		FAKE_IMAGE_FIXTURE_URL:
			"Fake 图像 Provider 固定返回的图片 URL（可选）；留空时使用后端内置本地 SVG 占位图，不调用外部图像 API。",
		CRITIQUE_ENABLED:
			"是否启用 Critic 质量审查闭环；开启后会审查角色图/分镜图，不达标时触发重生成。",
		CRITIQUE_SCORE_THRESHOLD:
			"Critic 质量分阈值（0-10）；低于该分数视为不达标并进入重生成逻辑。",
		CRITIQUE_MAX_ROUNDS:
			"Critic 最多重试轮数；达到上限后为避免卡死会继续后续流程。",
		OUTLINE_ENABLED:
			"是否启用故事大纲审批流程；开启后先生成大纲并等待确认，再继续角色和分镜规划。",

		// 视频服务
		VIDEO_PROVIDER:
			"视频服务提供商：openai（OpenAI 兼容）/ doubao（豆包）/ fake（本地测试）",
		VIDEO_BASE_URL: "视频生成服务地址（OpenAI 兼容接口）",
		VIDEO_API_KEY: "视频生成 API 密钥",
		VIDEO_MODEL: "视频生成模型名称",
		VIDEO_ENDPOINT: "视频生成 API 端点路径",
		VIDEO_MODE: "视频生成模式：text（文生视频）或 image（图生视频）",
		ENABLE_IMAGE_TO_VIDEO: "是否启用图生视频（I2V）功能",
		FAKE_VIDEO_FIXTURE_URL:
			"Fake 视频 Provider 固定返回的视频 URL；推荐使用 /static/videos/*.mp4，本地测试不调用外部视频 API。",
		FAKE_VIDEO_FIXTURE_PATH:
			"Fake 视频 Provider 本地素材文件路径；会复制到后端 static/videos 后返回本地 URL。",

		// 豆包视频
		DOUBAO_API_KEY: "豆包 API 密钥（火山引擎 ARK_API_KEY）",
		DOUBAO_VIDEO_MODEL: "豆包视频模型 ID",
		DOUBAO_VIDEO_DURATION: "豆包视频时长：5 或 10（秒）",
		DOUBAO_VIDEO_RATIO: "豆包视频比例：16:9 / 9:16 / 1:1 / adaptive",
		DOUBAO_GENERATE_AUDIO: "豆包视频是否生成音频",
		VIDEO_IMAGE_MODE:
			"图生视频模式：first_frame（仅首帧）/ reference（拼接参考图）",
		VIDEO_INLINE_LOCAL_IMAGES: "未配置 PUBLIC_BASE_URL 时是否内联本地图片",

		// TTS / BGM
		TTS_ENABLED: "是否启用 TTS 配音（Edge TTS）；关闭后只生成画面/视频，不合成语音。",
		TTS_DEFAULT_VOICE:
			"默认 TTS 语音名称，例如 zh-CN-XiaoxiaoNeural；用于分镜对白配音。",
		BGM_ENABLED: "是否启用背景音乐合成；关闭后最终视频不叠加 BGM。",
		BGM_VOLUME: "背景音乐音量，范围 0-1；数值越大 BGM 越响。",
		TTS_VOLUME: "TTS 人声音量，范围 0-1；数值越大对白越响。",
		BGM_DIRECTORY: "BGM 音频文件目录，相对于后端 app 目录。",

		// 思考链
		THINKING_CHAIN_ENABLED:
			"是否向前端推送 Agent 思考链/阶段说明；关闭可减少运行时消息噪音。",
		THINKING_CHAIN_DETAIL_LEVEL:
			"思考链详细级别：minimal 仅关键结论，normal 含审查阶段，verbose 展示更多规划/推理过程。",

		// 其他
		REQUEST_TIMEOUT_S: "HTTP 请求超时时间（秒）",
		PUBLIC_BASE_URL: "对外可访问的后端地址，用于生成完整 URL",
		ADMIN_TOKEN: "管理员 Token，用于配置更新权限验证",
	};

	return descriptions[key.toUpperCase()] || "暂无说明";
}

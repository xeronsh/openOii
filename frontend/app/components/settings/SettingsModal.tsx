import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSettingsStore } from "~/stores/settingsStore";
import { configApi } from "~/services/api";
import type { ConfigValue } from "~/types";
import { Dialog } from "~/components/ui/Dialog";
import { groupConfigs } from "~/utils/configGroups";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { PlainButton } from "../../components/ui/PlainButton";
import { SettingsAlert, type AlertState } from "./SettingsAlert";
import { SettingsSection } from "./SettingsSection";
import { TAB_CONFIG } from "./settingsTabs";
import { testOverrides, testServiceFor } from "./testConnection";
import { SvgIcon } from "~/components/ui/SvgIcon";

export function SettingsModal() {
	const { isModalOpen, closeModal } = useSettingsStore();
	const queryClient = useQueryClient();
	const [formState, setFormState] = useState<Record<string, ConfigValue>>({});
	const [initialFormState, setInitialFormState] = useState<
		Record<string, ConfigValue>
	>({});
	const [activeTab, setActiveTab] = useState("text");
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

	const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

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

	const handleTestConnection = async () => {
		const service = testServiceFor(activeTab);
		if (!service) return;
		const normalizedFormState = testOverrides(service, formState);
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

	const focusTab = (tab: string) => {
		setActiveTab(tab);
		tabRefs.current[tab]?.focus();
	};

	const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const currentIndex = sections.findIndex((section) => section.key === activeTab);
		if (currentIndex < 0 || sections.length === 0) return;

		const keyHandlers: Record<string, () => void> = {
			ArrowRight: () => focusTab(sections[(currentIndex + 1) % sections.length].key),
			ArrowDown: () => focusTab(sections[(currentIndex + 1) % sections.length].key),
			ArrowLeft: () => focusTab(sections[(currentIndex - 1 + sections.length) % sections.length].key),
			ArrowUp: () => focusTab(sections[(currentIndex - 1 + sections.length) % sections.length].key),
			Home: () => focusTab(sections[0].key),
			End: () => focusTab(sections[sections.length - 1].key),
		};

		const handler = keyHandlers[event.key];
		if (!handler) return;
		event.preventDefault();
		handler();
	};

	const activeSection = sections.find((s) => s.key === activeTab);

	return (
		<>
			<Dialog
				open
				onClose={closeModal}
				closeOnBackdrop={false}
				labelledBy="settings-modal-title"
				className="flex max-h-[92dvh] w-[min(96vw,76rem)] flex-col p-0"
			>
				<div className="flex shrink-0 items-center justify-between border-b border-line bg-paper-200 px-3 py-2 sm:px-4">
					<h3
						id="settings-modal-title"
						className="flex items-center gap-1.5 text-md font-bold"
					>
						<SvgIcon name="settings" size={20} className="text-primary" />
						<span>系统设置</span>
						<span className="hidden text-xs font-normal text-ink-muted sm:inline">模型 · 存储 · 运行</span>
					</h3>
					<IconButton
						onClick={handleCancel}
						aria-label="关闭设置"
						title="关闭设置"
					>
						<SvgIcon name="x" size={16} />
					</IconButton>
				</div>

				{isLoading && (
					<div className="flex items-center justify-center p-8">
						<span className="spinner-doodle h-5 w-5" />
					</div>
				)}

				{isError && (
					<div className="p-3">
						<div
							role="alert"
							className="alert-doodle bg-error/10 text-error-fg border border-error py-2 text-sm"
						>
							<SvgIcon name="warning-circle" size={20} />
							<span>加载配置失败，请检查后端服务是否正常运行。</span>
						</div>
					</div>
				)}

				{config && (
					<form
						onSubmit={handleSubmit}
						className="flex min-h-0 flex-1 flex-col"
					>
						<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
							<nav className="shrink-0 border-b border-line bg-paper-200/45 p-2 lg:w-56 lg:border-b-0 lg:border-r" aria-label="设置分类">
							<div role="tablist" aria-label="设置分类" onKeyDown={handleTabKeyDown} className="flex gap-1.5 overflow-x-auto lg:flex-col">
								{sections.map((section) => {
									const cfg = TAB_CONFIG[section.key];
									const isActive = activeTab === section.key;
									return (
										<PlainButton
											key={section.key}
											ref={(node) => {
												tabRefs.current[section.key] = node;
											}}
											id={`settings-tab-${section.key}`}
											role="tab"
											aria-selected={isActive}
											aria-controls="settings-panel"
											tabIndex={isActive ? 0 : -1}
											onClick={() => handleTabChange(section.key)}
											className={`
                        touch-target-dense flex shrink-0 items-center justify-between gap-2 border px-2.5
                        text-xs font-semibold lg:w-full
												border border-line-strong transition-colors duration-fast
                        ${
													isActive
														? "bg-primary text-primary-content"
														: "bg-paper-200 hover:bg-paper-300"
												}
                      `}
										>
											{cfg ? <SvgIcon name={cfg.icon} size={16} /> : null}
											<span>{cfg?.title || section.title}</span>
											<span
												className={`
                        rounded-sm px-1 py-0.5 text-xs tabular-nums
                        ${isActive ? "bg-primary-content/20" : "bg-paper-300"}
                      `}
											>
												{section.items.length}
											</span>
									</PlainButton>
									);
								})}
							</div>
							</nav>

						<div
							id="settings-panel"
							role="tabpanel"
							aria-labelledby={`settings-tab-${activeTab}`}
							tabIndex={0}
							className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 lg:p-6"
						>
							{activeSection ? (
								<SettingsSection
									tab={activeTab}
									items={activeSection.items}
									formState={formState}
									onChange={handleInputChange}
								/>
							) : null}
							</div>
						</div>

						<div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-paper-200 px-3 py-2 sm:px-4">
							<div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-ink-muted">
								<SvgIcon name="info" size={16} className="shrink-0" />
								<span className="truncate" id="settings-footer-hint">
									{testServiceFor(activeTab)
										? "大部分配置保存后立即生效，数据库配置需重启"
										: "这一类没有外部服务可测，测试连接只对文本、图像、视频服务可用"}
								</span>
							</div>

							<Button variant="secondary" size="sm"
								onClick={handleCancel}
							>
								取消
							</Button>

							<Button variant="primary" size="sm"
								type="submit"
								disabled={updateMutation.isPending}
							>
								{updateMutation.isPending && (
									<span className="spinner-doodle h-3 w-3" />
								)}
								保存配置
							</Button>
							<Button variant="secondary" size="sm"
								onClick={handleTestConnection}
								disabled={
									updateMutation.isPending ||
									isTestingConnection ||
									!testServiceFor(activeTab)
								}
								title={testServiceFor(activeTab) ? undefined : "这一类没有外部服务可测"}
								aria-describedby={testServiceFor(activeTab) ? undefined : "settings-footer-hint"}
							>
								{isTestingConnection && (
									<span className="spinner-doodle h-3 w-3" />
								)}
								测试连接
							</Button>
						</div>
					</form>
				)}
			</Dialog>

			<SettingsAlert
				alert={alertState}
				onDismiss={() => setAlertState((current) => ({ ...current, show: false }))}
				onConfirm={() => {
					setAlertState({ ...alertState, show: false });
					closeModal();
				}}
			/>
		</>
	);
}

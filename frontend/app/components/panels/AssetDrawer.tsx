import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { assetsApi, getStaticUrl } from "~/services/api";
import { Button } from "~/components/ui/Button";
import { SvgIcon } from "~/components/ui/SvgIcon";
import type { Asset, AssetCreatePayload } from "~/types";
import type { IconName } from "~/components/ui/SvgIcon";

type AssetType = "character" | "scene";

const ASSET_TABS: { key: AssetType | "all"; label: string; icon: IconName }[] =
	[
		{ key: "all", label: "全部", icon: "layers" },
		{ key: "character", label: "角色", icon: "star" },
		{ key: "scene", label: "场景", icon: "image" },
	];

interface AssetDrawerProps {
	open: boolean;
	onClose: () => void;
	/** 当前项目 ID — 传入时显示"使用"按钮 */
	projectId?: number;
}

/* ---------- Create Asset Form ---------- */

interface CreateAssetFormProps {
	isOpen: boolean;
	onClose: () => void;
	onCreated: () => void;
}

function CreateAssetForm({ isOpen, onClose, onCreated }: CreateAssetFormProps) {
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [assetType, setAssetType] = useState<AssetType | "">("");
	const [description, setDescription] = useState("");
	const [imageFile, setImageFile] = useState<File | null>(null);
	const [imagePreview, setImagePreview] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	if (!isOpen) return null;

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file) {
			if (!file.type.startsWith("image/")) {
				setError("仅支持图片文件");
				return;
			}
			if (file.size > 10 * 1024 * 1024) {
				setError("图片大小不能超过 10MB");
				return;
			}
			setImageFile(file);
			setError(null);
			const reader = new FileReader();
			reader.onload = (ev) => setImagePreview(ev.target?.result as string);
			reader.readAsDataURL(file);
		}
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		const file = e.dataTransfer.files[0];
		if (file) {
			if (!file.type.startsWith("image/")) {
				setError("仅支持图片文件");
				return;
			}
			if (file.size > 10 * 1024 * 1024) {
				setError("图片大小不能超过 10MB");
				return;
			}
			setImageFile(file);
			setError(null);
			const reader = new FileReader();
			reader.onload = (ev) => setImagePreview(ev.target?.result as string);
			reader.readAsDataURL(file);
		}
	};

	const handleSubmit = async () => {
		if (!name.trim()) {
			setError("请输入资产名称");
			return;
		}
		if (!assetType) {
			setError("请选择资产类型");
			return;
		}

		setIsSubmitting(true);
		setError(null);

		try {
			let imageUrl: string | null = null;
			if (imageFile) {
				const result = await assetsApi.uploadImage(imageFile);
				imageUrl = result.url;
			}

			const payload: AssetCreatePayload = {
				name: name.trim(),
				asset_type: assetType,
				description: description.trim() || null,
				image_url: imageUrl,
			};

			await assetsApi.create(payload);
			queryClient.invalidateQueries({ queryKey: ["assets"] });
			resetForm();
			onCreated();
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建失败");
		} finally {
			setIsSubmitting(false);
		}
	};

	const resetForm = () => {
		setName("");
		setAssetType("");
		setDescription("");
		setImageFile(null);
		setImagePreview(null);
		setError(null);
		if (fileInputRef.current) fileInputRef.current.value = "";
	};

	const handleClose = () => {
		resetForm();
		onClose();
	};

	return (
		<>
			<div
				className="fixed inset-0 z-modal-backdrop bg-neutral/45"
				onClick={handleClose}
			/>
			<div className="fixed right-0 top-0 z-modal flex h-full w-72 flex-col border-l-2 border-base-content/15 bg-base-100 shadow-brutal-sm">
				<div className="flex items-center justify-between border-b-2 border-base-content/10 px-2.5 py-2">
					<div className="flex items-center gap-1.5">
						<SvgIcon name="plus" size={14} className="text-primary" />
						<h3 className="m-0 font-heading text-sm font-bold">
							新建资产
						</h3>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="!h-7 !min-h-7 !px-1"
						onClick={handleClose}
						aria-label="关闭新建资产"
					>
						<SvgIcon name="x" size={14} />
					</Button>
				</div>

				<div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
					{/* Name */}
					<div className="form-control">
						<label className="label py-1">
							<span className="label-text text-xs font-medium">
								名称 <span className="text-error">*</span>
							</span>
						</label>
						<input
							type="text"
							placeholder="输入资产名称"
							className="input input-xs input-bordered w-full text-xs"
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={100}
						/>
					</div>

					{/* Type */}
					<div className="form-control">
						<label className="label py-1">
							<span className="label-text text-xs font-medium">
								类型 <span className="text-error">*</span>
							</span>
						</label>
						<div className="flex gap-2">
							<button
								type="button"
								className={`flex-1 btn btn-xs ${
									assetType === "character"
										? "btn-primary"
										: "btn-outline btn-ghost"
								}`}
								onClick={() => setAssetType("character")}
							>
								<SvgIcon name="star" size={12} className="mr-1" />
								角色
							</button>
							<button
								type="button"
								className={`flex-1 btn btn-xs ${
									assetType === "scene"
										? "btn-primary"
										: "btn-outline btn-ghost"
								}`}
								onClick={() => setAssetType("scene")}
							>
								<SvgIcon name="image" size={12} className="mr-1" />
								场景
							</button>
						</div>
					</div>

					{/* Description */}
					<div className="form-control">
						<label className="label py-1">
							<span className="label-text text-xs font-medium">描述</span>
						</label>
						<textarea
							placeholder="输入资产描述（可选）"
							className="textarea textarea-xs textarea-bordered w-full text-xs h-16"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
						/>
					</div>

					{/* Image upload */}
					<div className="form-control">
						<label className="label py-1">
							<span className="label-text text-xs font-medium">图片</span>
						</label>
						{imagePreview ? (
							<div className="relative group">
								<img
									src={imagePreview}
									alt="预览"
									className="w-full h-28 object-cover rounded-lg border-2 border-base-content/10"
								/>
								<button
									type="button"
									className="absolute top-1 right-1 btn btn-xs btn-circle btn-ghost bg-base-300/80 hover:bg-error/80 hover:text-error-content"
									onClick={() => {
										setImageFile(null);
										setImagePreview(null);
										if (fileInputRef.current)
											fileInputRef.current.value = "";
									}}
									aria-label="移除图片"
								>
									<SvgIcon name="x" size={10} />
								</button>
							</div>
						) : (
							<div
								className="flex flex-col items-center justify-center h-20 border-2 border-dashed border-base-content/20 rounded-lg cursor-pointer hover:border-primary/40 transition-colors"
								onClick={() => fileInputRef.current?.click()}
								onDragOver={(e) => e.preventDefault()}
								onDrop={handleDrop}
							>
								<SvgIcon
									name="image"
									size={20}
									className="text-base-content/25 mb-1"
								/>
								<span className="text-xs text-bc-muted">
									点击上传或拖拽图片
								</span>
							</div>
						)}
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							className="hidden"
							onChange={handleFileChange}
						/>
					</div>

					{/* Error */}
					{error && (
						<div className="text-xs text-error flex items-center gap-1">
							<SvgIcon name="triangle-alert" size={12} />
							{error}
						</div>
					)}

					{/* Actions */}
					<div className="flex gap-2 mt-auto pt-2">
						<Button
							variant="ghost"
							size="sm"
							className="flex-1"
							onClick={handleClose}
							disabled={isSubmitting}
						>
							取消
						</Button>
						<Button
							variant="primary"
							size="sm"
							className="flex-1"
							onClick={handleSubmit}
							loading={isSubmitting}
							disabled={!name.trim() || !assetType}
						>
							确认创建
						</Button>
					</div>
				</div>
			</div>
		</>
	);
}

/* ---------- Asset Card ---------- */

function AssetCard({
	asset,
	projectId,
	onDelete,
	onUse,
	isUsing,
}: {
	asset: Asset;
	projectId?: number;
	onDelete: (id: number) => void;
	onUse: (asset: Asset) => void;
	isUsing: boolean;
}) {
	return (
		<div className="card card-compact bg-base-200 border-2 border-base-content/10 hover:border-primary/40 transition-colors">
			<figure className="h-32 bg-base-300 overflow-hidden">
				{asset.image_url ? (
					<img
						src={getStaticUrl(asset.image_url) ?? undefined}
						alt={asset.name}
						className="w-full h-full object-cover"
						loading="lazy"
					/>
				) : (
					<div className="flex items-center justify-center w-full h-full text-base-content/20">
						<SvgIcon name="image" size={32} />
					</div>
				)}
			</figure>
			<div className="card-body p-2 gap-1">
				<div className="flex items-center gap-1">
					<span className="badge badge-xs badge-outline shrink-0">
						{asset.asset_type === "character"
							? "角色"
							: asset.asset_type === "scene"
								? "场景"
								: "风格"}
					</span>
					<h4 className="text-xs font-bold flex-1 truncate">{asset.name}</h4>
				</div>
				{asset.description && (
					<p className="text-xs text-bc-muted line-clamp-2">
						{asset.description}
					</p>
				)}
				<div className="flex items-center justify-end gap-1 mt-0.5">
					{projectId &&
						(asset.asset_type === "character" ||
							asset.asset_type === "scene") && (
							<Button
								variant="ghost"
								size="sm"
								className="!px-1.5 !py-0 !min-h-0 !h-5 text-xs text-primary-ink hover:opacity-80"
								onClick={() => onUse(asset)}
								disabled={isUsing}
								title="添加到当前项目"
							>
								<SvgIcon name="plus" size={10} className="mr-0.5" />
								使用
							</Button>
						)}
					<Button
						variant="ghost"
						size="sm"
						className="!px-1 !py-0 !min-h-0 !h-5 text-xs text-error/60 hover:text-error"
						onClick={() => onDelete(asset.id)}
						title="删除资产"
					>
						<SvgIcon name="x" size={12} />
					</Button>
				</div>
			</div>
		</div>
	);
}

/* ---------- Asset Drawer ---------- */

export function AssetDrawer({ open, onClose, projectId }: AssetDrawerProps) {
	const queryClient = useQueryClient();
	const [activeTab, setActiveTab] = useState<AssetType | "all">("all");
	const [search, setSearch] = useState("");
	const [showCreateForm, setShowCreateForm] = useState(false);

	const assetType = activeTab === "all" ? undefined : activeTab;

	const { data, isLoading } = useQuery({
		queryKey: ["assets", assetType, search],
		queryFn: () => assetsApi.list({ assetType, search: search || undefined }),
		enabled: open,
	});

	const deleteMutation = useMutation({
		mutationFn: (id: number) => assetsApi.delete(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["assets"] }),
	});

	const useMutation_ = useMutation({
		mutationFn: (asset: Asset) => assetsApi.useInProject(asset.id, projectId!),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["assets"] });
			if (projectId) {
				queryClient.invalidateQueries({
					queryKey: ["project", projectId, "characters"],
				});
				queryClient.invalidateQueries({
					queryKey: ["project", projectId, "shots"],
				});
			}
		},
	});

	const items = data?.items ?? [];

	return (
		<>
			{open && (
				<div
					className="fixed inset-0 z-modal-backdrop bg-neutral/40"
					onClick={onClose}
				/>
			)}
			<div
				className={`fixed right-0 top-0 z-modal h-full w-72 transform border-l-2 border-base-content/15 bg-base-100 shadow-brutal-sm transition-transform duration-normal ${open ? "translate-x-0" : "translate-x-full"}`}
			>
				<div className="flex items-center justify-between border-b-2 border-base-content/10 px-2.5 py-2">
					<div className="flex items-center gap-1.5">
						<SvgIcon name="archive" size={14} className="text-primary" />
						<h3 className="m-0 font-heading text-sm font-bold">
							资产库
						</h3>
						<span className="badge badge-xs badge-ghost tabular-nums">
							{data?.total ?? 0}
						</span>
					</div>
					<div className="flex items-center gap-0.5">
						<Button
							variant="ghost"
							size="sm"
							className="!h-7 !min-h-7 !px-1 text-primary-ink hover:opacity-80"
							onClick={() => setShowCreateForm(true)}
							title="新建资产"
							aria-label="新建资产"
						>
							<SvgIcon name="plus" size={14} />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="!h-7 !min-h-7 !px-1"
							onClick={onClose}
							aria-label="关闭资产库"
						>
							<SvgIcon name="x" size={14} />
						</Button>
					</div>
				</div>

				<div className="flex border-b-2 border-base-content/10">
					{ASSET_TABS.map((tab) => (
						<button
							key={tab.key}
							className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs font-medium transition-colors border-b-2 -mb-[2px] ${
								activeTab === tab.key
									? "border-primary text-primary-ink"
									: "border-transparent text-bc-muted hover:text-base-content/80"
							}`}
							onClick={() => setActiveTab(tab.key)}
						>
							<SvgIcon name={tab.icon} size={12} />
							{tab.label}
						</button>
					))}
				</div>

				{/* Search */}
				<div className="px-3 pt-2">
					<input
						type="text"
						placeholder="搜索资产名称…"
						className="input input-xs input-bordered w-full text-xs"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>

				{/* Content */}
				<div
					className="p-3 overflow-y-auto"
					style={{ height: "calc(100vh - 160px)" }}
				>
					{isLoading ? (
						<div className="flex items-center justify-center py-8">
							<span className="loading loading-spinner loading-sm text-primary" />
						</div>
					) : items.length === 0 ? (
						<div className="text-center text-xs text-bc-muted py-8">
							<SvgIcon
								name="layers"
								size={24}
								className="mx-auto mb-2 text-base-content/15"
							/>
							{search ? (
								<p>没有匹配的资产</p>
							) : (
								<>
									<p>还没有保存的资产</p>
									<p className="text-bc-subtle mt-1">
										点击{" "}
										<SvgIcon name="plus" size={10} className="inline" />{" "}
										新建，或在画布角色卡片点击{" "}
										<SvgIcon name="star" size={10} className="inline" />{" "}
										可添加
									</p>
								</>
							)}
						</div>
					) : (
						<div className="grid grid-cols-2 gap-2">
							{items.map((a) => (
								<AssetCard
									key={a.id}
									asset={a}
									projectId={projectId}
									onDelete={(id) => deleteMutation.mutate(id)}
									onUse={(asset) => useMutation_.mutate(asset)}
									isUsing={useMutation_.isPending}
								/>
							))}
						</div>
					)}
				</div>
			</div>

			{/* Create Asset Form — overlays the drawer */}
			<CreateAssetForm
				isOpen={showCreateForm}
				onClose={() => setShowCreateForm(false)}
				onCreated={() => setShowCreateForm(false)}
			/>
		</>
	);
}

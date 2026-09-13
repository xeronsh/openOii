import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "~/components/ui/Button";
import { SvgIcon } from "~/components/ui/SvgIcon";
import { getStaticUrl, versionsApi } from "~/services/api";
import { useEditorStore } from "~/stores/editorStore";
import type { ArtifactVersion, VersionDiff, VersionEntityType } from "~/types";
import { toast } from "~/utils/toast";

interface VersionCompareDrawerProps {
	open: boolean;
	projectId: number;
	initialEntityType?: VersionEntityType;
	initialEntityId?: number | null;
	onClose: () => void;
}

const LABELS: Record<string, string> = {
	name: "名称",
	description: "描述",
	image_url: "图片",
	prompt: "视频提示词",
	image_prompt: "图片提示词",
	dialogue: "对白",
	action: "动作",
	scene: "场景",
	camera: "镜头",
	lighting: "光线",
	expression: "表情",
	sfx: "音效",
	visual_notes: "视觉设定",
};

const DISPLAY_FIELDS = [
	"name",
	"description",
	"scene",
	"action",
	"dialogue",
	"camera",
	"lighting",
	"expression",
	"prompt",
	"image_prompt",
	"visual_notes",
];

function valueToText(value: unknown): string {
	if (value === null || value === undefined || value === "") return "—";
	if (Array.isArray(value)) return value.join(", ");
	if (typeof value === "object") return JSON.stringify(value, null, 2);
	return String(value);
}

function versionLabel(version: ArtifactVersion): string {
	return `v${version.version} · ${version.trigger}`;
}

function VersionColumn({ title, version }: { title: string; version?: ArtifactVersion }) {
	const imageUrl = getStaticUrl(version?.snapshot.image_url as string | null | undefined);
	return (
		<section className="min-w-0 rounded-md border-2 border-base-content/15 bg-base-200/60 p-2.5">
			<h3 className="m-0 font-heading text-xs font-bold">{title}</h3>
			<div className="mt-1.5 aspect-video overflow-hidden rounded-sm border border-base-content/10 bg-base-300">
				{imageUrl ? (
					<img src={imageUrl} alt={title} className="h-full w-full object-cover" />
				) : (
					<div className="flex h-full items-center justify-center text-2xs text-bc-muted">
						图片不存在或未生成
					</div>
				)}
			</div>
			<div className="mt-2 space-y-1.5">
				{DISPLAY_FIELDS.map((field) => {
					const value = version?.snapshot[field];
					if (value === undefined || value === null || value === "") return null;
					return (
						<div key={field} className="text-2xs">
							<div className="font-semibold text-bc-muted">{LABELS[field] || field}</div>
							<div className="whitespace-pre-wrap break-words">{valueToText(value)}</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}

function DiffRow({ diff }: { diff: VersionDiff }) {
	return (
		<li className="rounded border border-base-content/10 bg-base-100 p-2 text-xs">
			<div className="mb-1 font-semibold">{LABELS[diff.field_name] || diff.field_name}</div>
			<div className="grid gap-2 md:grid-cols-2">
				<div className="rounded bg-error/10 p-2">
					<div className="mb-1 text-error">旧</div>
					<pre className="whitespace-pre-wrap break-words font-sans">{valueToText(diff.old_value)}</pre>
				</div>
				<div className="rounded bg-success/10 p-2">
					<div className="mb-1 text-success">新</div>
					<pre className="whitespace-pre-wrap break-words font-sans">{valueToText(diff.new_value)}</pre>
				</div>
			</div>
		</li>
	);
}

export function VersionCompareDrawer({
	open,
	projectId,
	initialEntityType = "character",
	initialEntityId = null,
	onClose,
}: VersionCompareDrawerProps) {
	const characters = useEditorStore((state) => state.characters);
	const shots = useEditorStore((state) => state.shots);
	const [entityType, setEntityType] = useState<VersionEntityType>(initialEntityType);
	const [entityId, setEntityId] = useState<number | null>(initialEntityId);
	const queryClient = useQueryClient();

	useEffect(() => {
		if (!open) return;
		setEntityType(initialEntityType);
		setEntityId(initialEntityId ?? null);
		setLeftVersion(null);
		setRightVersion(null);
	}, [initialEntityId, initialEntityType, open]);

	const characterEntities = entityType === "character" ? characters : [];
	const shotEntities = entityType === "shot" ? shots : [];
	const entities = entityType === "character" ? characterEntities : shotEntities;
	const selectedEntityId = entityId ?? entities[0]?.id ?? null;
	const versionsQuery = useQuery({
		queryKey: ["versions", projectId, entityType, selectedEntityId],
		queryFn: () => versionsApi.list(projectId, entityType, selectedEntityId ?? 0),
		enabled: open && projectId > 0 && Boolean(selectedEntityId),
	});
	const versions = versionsQuery.data?.versions ?? [];
	const [leftVersion, setLeftVersion] = useState<number | null>(null);
	const [rightVersion, setRightVersion] = useState<number | null>(null);
	const effectiveLeft = leftVersion ?? versions[1]?.version ?? versions[0]?.version ?? null;
	const effectiveRight = rightVersion ?? versions[0]?.version ?? null;

	const compareQuery = useQuery({
		queryKey: ["versions", "compare", projectId, entityType, selectedEntityId, effectiveLeft, effectiveRight],
		queryFn: () =>
			versionsApi.compare(
				projectId,
				entityType,
				selectedEntityId ?? 0,
				effectiveLeft ?? 1,
				effectiveRight ?? 1,
			),
		enabled: open && Boolean(selectedEntityId && effectiveLeft && effectiveRight),
	});

	const versionByNumber = useMemo(
		() => new Map(versions.map((version) => [version.version, version])),
		[versions],
	);
	const rollbackMutation = useMutation({
		mutationFn: (targetVersion: number) =>
			versionsApi.rollback(entityType, selectedEntityId ?? 0, targetVersion),
		onSuccess: (result) => {
			toast.success({ title: "版本回滚", message: result.message });
			queryClient.invalidateQueries({ queryKey: ["versions"] });
			queryClient.invalidateQueries({ queryKey: ["project", projectId] });
		},
		onError: () => toast.error({ title: "版本回滚", message: "回滚失败" }),
	});

	const handleEntityTypeChange = (nextType: VersionEntityType) => {
		setEntityType(nextType);
		const nextEntities = nextType === "character" ? characters : shots;
		setEntityId(nextEntities[0]?.id ?? null);
		setLeftVersion(null);
		setRightVersion(null);
	};

	return (
		<aside
			className={`fixed right-0 top-0 z-modal h-full w-full max-w-5xl transform overflow-y-auto border-l-2 border-base-content/15 bg-base-100 shadow-brutal-sm transition-transform duration-normal ${
				open ? "translate-x-0" : "translate-x-full"
			}`}
		>
			<div className="sticky top-0 z-sticky flex items-center gap-2 border-b-2 border-base-content/10 bg-base-100 px-3 py-2">
				<SvgIcon name="clock-3" size={16} />
				<h2 className="m-0 font-heading text-md font-bold">
					版本对比
				</h2>
				<button
					type="button"
					className="btn btn-ghost btn-circle touch-target-dense ml-auto h-8 min-h-8 w-8"
					onClick={onClose}
					aria-label="关闭版本对比"
					title="关闭版本对比"
				>
					<SvgIcon name="x" size={14} />
				</button>
			</div>

			<div className="space-y-3 p-3">
				<div className="grid gap-2 md:grid-cols-4">
					<select
						className="select select-bordered select-sm h-8 min-h-8"
						value={entityType}
						onChange={(e) => handleEntityTypeChange(e.currentTarget.value as VersionEntityType)}
					>
						<option value="character">角色</option>
						<option value="shot">分镜</option>
					</select>
					<select
						className="select select-bordered select-sm h-8 min-h-8 md:col-span-3"
						value={selectedEntityId ?? ""}
						onChange={(e) => setEntityId(Number(e.currentTarget.value))}
					>
						{entityType === "character"
							? characterEntities.map((entity) => (
								<option key={entity.id} value={entity.id}>{entity.name}</option>
							))
							: shotEntities.map((entity) => (
								<option key={entity.id} value={entity.id}>{`镜头 ${entity.order}`}</option>
							))}
					</select>
				</div>

				{versionsQuery.isLoading && (
					<div className="text-xs text-bc-muted">
						加载版本中...
					</div>
				)}
				{!versionsQuery.isLoading && versions.length === 0 && (
					<div className="rounded-md border border-base-content/10 p-4 text-xs text-bc-muted">
						暂无版本快照。生成或重新生成后会自动记录。
					</div>
				)}

				{versions.length > 0 && (
					<>
						<div className="grid gap-2 md:grid-cols-2">
							<select
								className="select select-bordered select-sm h-8 min-h-8"
								value={effectiveLeft ?? ""}
								onChange={(e) => setLeftVersion(Number(e.currentTarget.value))}
							>
								{versions.map((version) => (
									<option key={version.id} value={version.version}>{versionLabel(version)}</option>
								))}
							</select>
							<select
								className="select select-bordered select-sm h-8 min-h-8"
								value={effectiveRight ?? ""}
								onChange={(e) => setRightVersion(Number(e.currentTarget.value))}
							>
								{versions.map((version) => (
									<option key={version.id} value={version.version}>{versionLabel(version)}</option>
								))}
							</select>
						</div>

						<div className="grid gap-3 lg:grid-cols-2">
							<VersionColumn title={`旧版本 v${effectiveLeft ?? "—"}`} version={effectiveLeft ? versionByNumber.get(effectiveLeft) : undefined} />
							<VersionColumn title={`新版本 v${effectiveRight ?? "—"}`} version={effectiveRight ? versionByNumber.get(effectiveRight) : undefined} />
						</div>

						<section className="rounded-md border-2 border-base-content/10 bg-base-200/40 p-2.5">
							<h3 className="mb-1.5 font-heading text-xs font-bold">
								差异
							</h3>
							{compareQuery.isLoading && (
								<div className="text-2xs text-bc-muted">
									计算差异中...
								</div>
							)}
							{!compareQuery.isLoading && (compareQuery.data?.diffs.length ?? 0) === 0 && (
								<div className="text-2xs text-bc-muted">
									两个版本内容相同。
								</div>
							)}
							<ul className="space-y-1.5">
								{compareQuery.data?.diffs.map((diff) => (
									<DiffRow key={diff.field_name} diff={diff} />
								))}
							</ul>
						</section>

						<div className="flex justify-end">
							<Button
								variant="secondary"
								size="sm"
								loading={rollbackMutation.isPending}
								disabled={!effectiveLeft || rollbackMutation.isPending}
								onClick={() => {
									if (!effectiveLeft) return;
									if (window.confirm(`回滚到版本 v${effectiveLeft}？后续版本不会删除。`)) {
										rollbackMutation.mutate(effectiveLeft);
									}
								}}
							>
								回滚到左侧版本
							</Button>
						</div>
					</>
				)}
			</div>
		</aside>
	);
}

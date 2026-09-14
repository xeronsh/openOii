import { useCallback, useState, type ReactNode } from "react";
import { track, useEditor } from "tldraw";
import {
	ArrowsPointingOutIcon,
	CursorArrowRaysIcon,
	HandRaisedIcon,
	MagnifyingGlassMinusIcon,
	MagnifyingGlassPlusIcon,
	Squares2X2Icon,
} from "@heroicons/react/24/outline";
import { projectsApi } from "~/services/api";
import { toast } from "~/utils/toast";

interface ComicCanvasToolbarProps {
	projectId: number;
	onResetLayout: () => void;
	sortMode?: boolean;
	sortDisabled?: boolean;
	onToggleSortMode?: () => void;
	fillDisabled?: boolean;
}

export const ComicCanvasToolbar = track(function ComicCanvasToolbar({
	projectId,
	onResetLayout,
	sortMode = false,
	sortDisabled = false,
	onToggleSortMode,
	fillDisabled = false,
}: ComicCanvasToolbarProps) {
	const editor = useEditor();
	const currentTool = editor.getCurrentToolId();
	const zoomPercent = Math.round(editor.getZoomLevel() * 100);
	const [filling, setFilling] = useState(false);

	const handleZoomIn = useCallback(() => {
		editor.zoomIn(editor.getViewportScreenCenter(), {
			animation: { duration: 180 },
		});
	}, [editor]);

	const handleZoomOut = useCallback(() => {
		editor.zoomOut(editor.getViewportScreenCenter(), {
			animation: { duration: 180 },
		});
	}, [editor]);

	const handleZoomReset = useCallback(() => {
		editor.resetZoom(editor.getViewportScreenCenter(), {
			animation: { duration: 180 },
		});
	}, [editor]);

	const handleZoomToFit = useCallback(() => {
		editor.zoomToFit({ animation: { duration: 260 } });
	}, [editor]);

	const handleFillEmpty = useCallback(
		async (type: "image" | "video") => {
			if (fillDisabled || filling) return;
			setFilling(true);
			try {
				await projectsApi.fillEmptyShots(projectId, type);
				toast.success({
					title: type === "image" ? "补齐空格 · 首帧" : "补齐空格 · 视频",
					message: "已启动，仅生成缺少产物的分镜格",
				});
			} catch (error) {
				toast.error({
					title: "补齐失败",
					message: error instanceof Error ? error.message : "请稍后重试",
				});
			} finally {
				setFilling(false);
			}
		},
		[fillDisabled, filling, projectId],
	);

	return (
		<div
			// <lg 不渲染：画布本身在移动端不挂载，工具条不能悬浮压住抽屉/聊天
			className="absolute bottom-4 left-1/2 z-dropdown hidden -translate-x-1/2 items-center justify-center gap-0.5 rounded-lg border-2 border-base-content/15 bg-base-100 p-1 text-base-content shadow-brutal-sm lg:flex"
			role="toolbar"
			aria-label="画布工具栏"
		>
			<ToolButton
				active={currentTool === "select"}
				label="选择工具"
				onClick={() => editor.setCurrentTool("select")}
			>
				<CursorArrowRaysIcon className="h-4 w-4" />
			</ToolButton>
			<ToolButton
				active={currentTool === "hand"}
				label="抓手工具"
				onClick={() => editor.setCurrentTool("hand")}
			>
				<HandRaisedIcon className="h-4 w-4" />
			</ToolButton>

			<Divider />

			<ToolButton label="缩小" onClick={handleZoomOut}>
				<MagnifyingGlassMinusIcon className="h-4 w-4" />
			</ToolButton>
			<button
				type="button"
				className="btn btn-sm btn-ghost touch-target-dense h-8 min-h-8 min-w-[3.25rem] font-mono text-2xs"
				onClick={handleZoomReset}
				aria-label={`${zoomPercent}%，重置缩放`}
				title="重置缩放"
			>
				{zoomPercent}%
			</button>
			<ToolButton label="放大" onClick={handleZoomIn}>
				<MagnifyingGlassPlusIcon className="h-4 w-4" />
			</ToolButton>
			<ToolButton label="适应视图" onClick={handleZoomToFit}>
				<ArrowsPointingOutIcon className="h-4 w-4" />
			</ToolButton>

			<Divider />

			<ToolButton label="整理画布" showLabel labelText="整理" onClick={onResetLayout}>
				<Squares2X2Icon className="h-4 w-4" />
			</ToolButton>
			{onToggleSortMode ? (
				<ToolButton
					active={sortMode}
					disabled={sortDisabled}
					label={sortMode ? "完成分镜排序" : "排序九宫格"}
					showLabel
					labelText={sortMode ? "完成排序" : "排序"}
					onClick={onToggleSortMode}
				>
					<span className="font-mono text-2xs font-bold">3×N</span>
				</ToolButton>
			) : null}
			<ToolButton
				disabled={fillDisabled || filling}
				label="补齐空格 · 首帧"
				showLabel
				labelText={filling ? "补齐中" : "补首帧"}
				onClick={() => handleFillEmpty("image")}
			>
				<span className="font-mono text-2xs font-bold">图</span>
			</ToolButton>
			<ToolButton
				disabled={fillDisabled || filling}
				label="补齐空格 · 视频"
				showLabel
				labelText={filling ? "补齐中" : "补视频"}
				onClick={() => handleFillEmpty("video")}
			>
				<span className="font-mono text-2xs font-bold">视</span>
			</ToolButton>

		</div>
	);
});

function Divider() {
	return <div className="mx-0.5 h-5 w-px bg-base-content/15" />;
}

function ToolButton({
	active,
	disabled,
	label,
	labelText,
	onClick,
	showLabel,
	children,
}: {
	active?: boolean;
	disabled?: boolean;
	label: string;
	labelText?: string;
	onClick: () => void;
	showLabel?: boolean;
	children: ReactNode;
}) {
	return (
		<div className="tooltip tooltip-top" data-tip={label}>
			<button
				type="button"
				className={`btn btn-sm touch-target-dense h-8 min-h-8 ${
					showLabel ? "min-w-0 gap-1 px-2" : "btn-square w-8"
				} ${
					active ? "btn-primary" : "btn-ghost text-base-content"
				}`}
				disabled={disabled}
				onClick={onClick}
				aria-label={label}
				title={label}
			>
				{children}
				{showLabel ? (
					<span className="whitespace-nowrap font-heading text-2xs font-semibold">
						{labelText ?? label}
					</span>
				) : null}
			</button>
		</div>
	);
}

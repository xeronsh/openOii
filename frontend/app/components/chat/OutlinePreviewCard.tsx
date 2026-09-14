import { useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import { Button } from "~/components/ui/Button";
import type { StoryOutline } from "~/types";

interface OutlinePreviewCardProps {
	outline: StoryOutline;
	visualBible?: string | null;
	onConfirm: () => void;
	onRegenerate: (feedback: string) => void;
}

function safeJson(value: StoryOutline): string {
	return JSON.stringify(value, null, 2);
}

export function OutlinePreviewCard({
	outline,
	visualBible,
	onConfirm,
	onRegenerate,
}: OutlinePreviewCardProps) {
	const [expanded, setExpanded] = useState(false);
	const [draft, setDraft] = useState(safeJson(outline));
	const [feedback, setFeedback] = useState("");

	const handleRegenerate = () => {
		const parts = [];
		if (feedback.trim()) parts.push(feedback.trim());
		if (draft.trim() && draft.trim() !== safeJson(outline)) {
			parts.push(`请按以下编辑后的大纲方向重新生成：\n${draft.trim()}`);
		}
		onRegenerate(parts.join("\n\n") || "请重新生成故事大纲");
	};

	return (
		<div className="card-comic bg-base-100 p-3 space-y-2 text-sm">
			<div>
				<p className="text-2xs uppercase tracking-widest text-bc-muted font-bold">
					Story Outline
				</p>
				<h3 className="font-heading font-bold text-base">故事大纲待确认</h3>
			</div>

			<p className="leading-relaxed text-base-content/80">{outline.logline}</p>

			{outline.genre.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{outline.genre.map((genre) => (
						<span key={genre} className="badge badge-outline badge-sm">
							{genre}
						</span>
					))}
				</div>
			)}

			<div className="space-y-1">
				{outline.acts.map((act) => (
					<div key={`${act.act}-${act.title}`} className="border-l-2 border-primary/40 pl-2">
						<p className="font-bold text-xs">
							第 {act.act} 幕 · {act.title}
						</p>
						<p className="text-xs text-bc-muted">{act.summary}</p>
					</div>
				))}
			</div>

			{visualBible && (
				<p className="text-xs text-bc-muted bg-base-200/60 rounded-md p-2">
					<span className="font-bold">视觉指南：</span>
					{visualBible.slice(0, 120)}{visualBible.length > 120 ? "..." : ""}
				</p>
			)}

			<button
				type="button"
				className="btn btn-ghost btn-xs gap-1 px-0 min-h-0 h-auto"
				onClick={() => setExpanded((v) => !v)}
			>
				{expanded ? <ChevronUpIcon className="w-3 h-3" /> : <ChevronDownIcon className="w-3 h-3" />}
				{expanded ? "收起编辑" : "展开详细大纲"}
			</button>

			{expanded && (
				<div className="space-y-2">
					<textarea
						className="textarea textarea-bordered w-full text-xs font-mono min-h-40"
						value={draft}
						onChange={(e) => setDraft(e.currentTarget.value)}
						aria-label="编辑故事大纲 JSON"
					/>
					<textarea
						className="textarea textarea-bordered w-full text-xs min-h-16"
						value={feedback}
						onChange={(e) => setFeedback(e.currentTarget.value)}
						placeholder="重新生成要求（可选）"
						aria-label="重新生成要求"
					/>
				</div>
			)}

			<div className="flex gap-2 pt-1">
				<Button size="sm" variant="primary" onClick={onConfirm} className="flex-1">
					确认大纲
				</Button>
				<Button size="sm" variant="secondary" onClick={handleRegenerate} className="flex-1">
					重新生成
				</Button>
			</div>
		</div>
	);
}

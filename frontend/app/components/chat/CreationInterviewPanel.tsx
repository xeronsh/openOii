import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "~/components/ui/Button";
import { Select } from "~/components/ui/Select";
import { projectQueryKeys } from "~/query/queryKeys";
import { projectsApi, textApi, universesApi } from "~/services/api";
import type { Project } from "~/types";
import {
	finalizeCreationInterview,
	readCreationInterview,
	saveCreationInterview,
	type CreationInterviewAnswer,
	type CreationInterviewQuestion,
} from "~/utils/creationInterview";

const STYLE_CATEGORIES = [
	{ group: "2D 动画", styles: [
		{ value: "anime", label: "日漫" },
		{ value: "shonen", label: "少年热血" },
		{ value: "slice-of-life", label: "日常治愈" },
		{ value: "manga", label: "黑白漫画" },
		{ value: "donghua", label: "国风动画" },
	] },
	{ group: "3D 风格", styles: [
		{ value: "cinematic", label: "电影质感" },
		{ value: "pixar", label: "3D 卡通" },
		{ value: "lowpoly", label: "低多边形" },
	] },
	{ group: "艺术风格", styles: [
		{ value: "watercolor", label: "水彩" },
		{ value: "sketch", label: "素描" },
		{ value: "realistic", label: "写实" },
	] },
];

export function CreationInterviewPanel({
	project,
	onStart,
	busy = false,
}: {
	project: Project;
	onStart: () => void;
	busy?: boolean;
}) {
	const queryClient = useQueryClient();
	const scrollRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const initialQuestionRequested = useRef(false);
	const [savedInterview] = useState(() => readCreationInterview(project.story));
	const baseStory = savedInterview.story;
	const [stage, setStage] = useState<"questions" | "settings">("questions");
	const [question, setQuestion] = useState<CreationInterviewQuestion | null>(null);
	const [draft, setDraft] = useState("");
	const [answers, setAnswers] = useState<CreationInterviewAnswer[]>(savedInterview.answers);
	const [pending, setPending] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState("");
	const [style, setStyle] = useState(project.style || "anime");
	const [universeId, setUniverseId] = useState<number | null>(project.universe_id ?? null);
	const [shotCount, setShotCount] = useState<number | undefined>(project.target_shot_count ?? undefined);
	const [characterHints, setCharacterHints] = useState<string[]>(
		project.character_hints.length ? project.character_hints : [""],
	);
	const [referenceImages, setReferenceImages] = useState(project.reference_images);
	const { data: universes = [], isLoading: universesLoading } = useQuery({
		queryKey: ["universes"],
		queryFn: () => universesApi.list(),
	});
	const selectedUniverse = universes.find((universe) => universe.id === universeId);
	const chapterNumber = universeId == null
		? null
		: universeId === project.universe_id && project.chapter_number
			? project.chapter_number
			: (selectedUniverse?.projects_count ?? 0) + 1;
	const creationModeLabel = project.creation_mode === "quick" ? "YOLO 模式" : "交互模式";

	const requestQuestion = useCallback(async (nextAnswers: CreationInterviewAnswer[], commit = false) => {
		setPending(true);
		setError("");
		try {
			if (commit) {
				const updated = await projectsApi.update(project.id, {
					story: saveCreationInterview(baseStory, nextAnswers),
				});
				queryClient.setQueryData(projectQueryKeys.project(project.id), updated);
				setAnswers(nextAnswers);
				setDraft("");
				setQuestion(null);
			}
			const result = await textApi.nextInterviewQuestion({
				story: baseStory,
				answers: nextAnswers.map(({ question, answer }) => ({ question, answer })),
			});
			setQuestion(result.question);
			setStage(result.ready ? "settings" : "questions");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "AI 访谈暂时无法继续，请检查文本模型配置后重试。");
		} finally {
			setPending(false);
		}
	}, [baseStory, project.id, queryClient]);

	useEffect(() => {
		if (initialQuestionRequested.current) return;
		initialQuestionRequested.current = true;
		void requestQuestion(savedInterview.answers);
	}, [requestQuestion]);

	useEffect(() => {
		if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [answers, question, stage, pending]);

	const submitAnswer = () => {
		if (!question || !draft.trim() || pending) return;
		void requestQuestion([...answers, { ...question, answer: draft.trim() }], true);
	};

	const reviseLastAnswer = () => {
		const last = answers.at(-1);
		if (!last || pending) return;
		setAnswers((current) => current.slice(0, -1));
		setQuestion(last);
		setDraft(last.answer);
		setStage("questions");
	};

	const uploadReferences = async (files: FileList | null) => {
		if (!files?.length) return;
		const selected = Array.from(files).slice(0, Math.max(0, 7 - referenceImages.length));
		if (!selected.length) return;
		setUploading(true);
		setError("");
		try {
			for (const file of selected) {
				const result = await projectsApi.uploadReference(project.id, file);
				setReferenceImages(result.reference_images);
			}
			queryClient.invalidateQueries({ queryKey: ["project", project.id] });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "参考图上传失败，请重试。");
		} finally {
			setUploading(false);
		}
	};

	const removeReference = async (index: number) => {
		const next = referenceImages.filter((_, itemIndex) => itemIndex !== index);
		setError("");
		try {
			const updated = await projectsApi.update(project.id, { reference_images: next });
			setReferenceImages(updated.reference_images);
			queryClient.invalidateQueries({ queryKey: ["project", project.id] });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "移除参考图失败，请重试。");
		}
	};

	const confirmSettings = async () => {
		if (pending || uploading || busy) return;
		setPending(true);
		setError("");
		try {
			const updated = await projectsApi.update(project.id, {
				story: finalizeCreationInterview(baseStory, answers),
				style,
				target_shot_count: shotCount,
				character_hints: characterHints.filter((hint) => hint.trim()),
				universe_id: universeId,
				chapter_number: chapterNumber,
				chapter_title: universeId == null ? null : project.chapter_title || project.title,
			});
			queryClient.setQueryData(projectQueryKeys.project(project.id), updated);
			onStart();
			setPending(false);
		} catch (cause) {
			setPending(false);
			setError(cause instanceof Error ? cause.message : "保存创作设置失败，请重试。");
		}
	};

	const addCharacterHint = () => {
		if (characterHints.length < 6) setCharacterHints((current) => [...current, ""]);
	};

	const updateCharacterHint = (index: number, value: string) => {
		setCharacterHints((current) => current.map((hint, itemIndex) => itemIndex === index ? value : hint));
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-paper-100" data-shell="creation-interview-chat">
			<header className="flex items-center justify-between gap-2 border-b border-ink/10 px-3 py-2">
				<div className="min-w-0">
					<p className="m-0 font-mono text-2xs uppercase text-ink-muted">创作准备 · AI 故事访谈</p>
					<h2 className="m-0 truncate font-heading text-sm font-bold">{creationModeLabel}</h2>
				</div>
				<span className="border border-primary/30 bg-primary/10 px-2 py-1 text-2xs font-bold text-primary-ink">确认后才开始生成</span>
			</header>

			<div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 halftone-bg">
				<div className="max-w-[92%] border-l-2 border-primary bg-paper-200/70 px-3 py-2">
					<p className="m-0 font-mono text-2xs uppercase text-primary-ink">你的故事</p>
					<p className="m-0 mt-1 whitespace-pre-wrap break-words text-xs">{baseStory}</p>
				</div>

				{answers.map((item, index) => (
					<div key={index} className="ml-auto max-w-[92%] border border-ink/15 bg-paper-100 px-3 py-2">
						<p className="m-0 font-mono text-2xs uppercase text-ink-muted">{item.label}</p>
						<p className="m-0 mt-1 text-xs font-semibold">{item.answer}</p>
					</div>
				))}

				{stage === "questions" ? (
					<>
						{pending && !question ? <p className="m-0 py-8 text-center text-xs text-ink-muted" role="status" aria-live="polite">AI 正在读故事并整理下一题…</p> : null}
						{question ? (
							<div className="space-y-3">
								<div className="border-l-2 border-primary bg-paper-200/70 px-3 py-2">
									<p className="m-0 font-mono text-2xs uppercase text-primary-ink">{question.label}</p>
									<h3 className="mb-0 mt-1 font-heading text-sm font-bold leading-snug">{question.question}</h3>
								</div>
								<div className="space-y-1.5">
									<p className="m-0 text-2xs font-semibold text-ink-muted">点选建议，或自己写</p>
									<div className="flex flex-wrap gap-1.5">
										{question.suggestions.map((suggestion) => (
											<button key={suggestion} type="button" className={`touch-target-dense border px-2.5 text-left text-xs transition-colors duration-fast ${draft === suggestion ? "border-primary bg-primary/10 text-primary-ink" : "border-ink/20 bg-paper-100 hover:border-primary/50"}`} onClick={() => setDraft(suggestion)} aria-pressed={draft === suggestion}>{suggestion}</button>
										))}
									</div>
								</div>
								<label className="sr-only" htmlFor="canvas-interview-answer">你的回答</label>
								<textarea id="canvas-interview-answer" className="input-doodle min-h-24 w-full resize-y bg-paper-100 p-2.5 text-base leading-normal" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitAnswer(); }} placeholder={question.placeholder} maxLength={1200} aria-required="true" />
								<Button size="sm" className="w-full" loading={pending} disabled={!draft.trim() || pending} onClick={submitAnswer}>回答并继续</Button>
							</div>
						) : null}
					</>
				) : (
					<div className="space-y-3">
						<p className="m-0 text-xs text-ink-muted">故事访谈完成。确认画面设置后，才会开始 {creationModeLabel}。</p>
						<div className="grid gap-2 sm:grid-cols-2">
							<label className="block text-xs font-bold">画面风格
								<Select containerClassName="mt-1" value={style} onChange={(event) => setStyle(event.target.value)}>
									{STYLE_CATEGORIES.map((category) => <optgroup key={category.group} label={category.group}>{category.styles.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>)}
								</Select>
							</label>
							<label className="block text-xs font-bold">IP 宇宙
								<Select containerClassName="mt-1" value={universeId ?? ""} onChange={(event) => setUniverseId(event.target.value ? Number(event.target.value) : null)} disabled={universesLoading}>
									<option value="">{universesLoading ? "加载宇宙…" : "独立项目"}</option>
									{universes.map((universe) => <option key={universe.id} value={universe.id}>{universe.name}</option>)}
								</Select>
							</label>
						</div>
						{selectedUniverse ? <p className="m-0 text-2xs text-ink-muted">第 {chapterNumber} 章 · 沿用世界观与共享角色</p> : null}

						<section className="space-y-1.5" aria-labelledby="canvas-reference-heading">
							<div className="flex items-center justify-between"><h3 id="canvas-reference-heading" className="m-0 text-xs font-bold">参考图</h3><span className="font-mono text-2xs tabular-nums text-ink-muted">{referenceImages.length}/7</span></div>
							<div className="flex flex-wrap gap-1.5">
								{referenceImages.map((image, index) => <div key={index} className="group relative h-10 w-10 border border-ink/15"><img src={image} alt={`参考图 ${index + 1}`} className="h-full w-full object-cover" width={40} height={40} /><button type="button" className="absolute inset-0 flex items-center justify-center bg-error/85 text-2xs font-bold text-error-content opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void removeReference(index)} aria-label={`删除参考图 ${index + 1}`}>删除</button></div>)}
								{referenceImages.length < 7 ? <button type="button" className="touch-target-dense border border-dashed border-ink/25 px-2 text-2xs font-semibold hover:border-primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>+ 添加</button> : null}
								<input ref={fileInputRef} type="file" accept="image/*" multiple className="sr-only" onChange={(event) => { void uploadReferences(event.target.files); event.target.value = ""; }} />
							</div>
						</section>

						<details className="border-y border-ink/15 py-1.5">
							<summary className="min-h-9 cursor-pointer py-2 text-xs font-bold">高级设置 · 镜头与角色</summary>
							<div className="space-y-2 border-t border-ink/10 pt-2">
								<label className="flex items-center justify-between gap-2 text-xs font-semibold">镜头数<input type="number" min={1} max={20} value={shotCount ?? ""} placeholder="自动" onChange={(event) => setShotCount(event.target.value ? Number(event.target.value) : undefined)} className="input-doodle h-9 w-24 bg-paper-100 text-sm" /></label>
								<div className="space-y-1.5"><div className="flex items-center justify-between"><span className="text-xs font-semibold">角色提示</span>{characterHints.length < 6 ? <button type="button" className="text-2xs font-bold text-primary-ink" onClick={addCharacterHint}>添加</button> : null}</div>{characterHints.map((hint, index) => <input key={index} type="text" className="input-doodle h-9 w-full bg-paper-100 text-sm" placeholder={`角色 ${index + 1}`} value={hint} onChange={(event) => updateCharacterHint(index, event.target.value)} />)}</div>
							</div>
						</details>

						{answers.length ? <details><summary className="cursor-pointer text-xs font-bold">访谈记录 · {answers.length} 项</summary><ol className="m-0 mt-2 list-none space-y-1 p-0">{answers.map((item, index) => <li key={index} className="border-l-2 border-primary/60 bg-paper-200/50 px-2 py-1.5"><p className="m-0 text-2xs font-bold">{item.question}</p><p className="m-0 mt-1 whitespace-pre-wrap text-2xs">{item.answer}</p></li>)}</ol></details> : null}
					</div>
				)}

				{error ? <p className="m-0 border-l-2 border-error bg-error/10 px-2.5 py-2 text-2xs text-error" role="alert">{error}</p> : null}
				{stage === "questions" && error && !question ? <Button variant="secondary" size="sm" className="w-full" onClick={() => void requestQuestion(answers)}>重试生成问题</Button> : null}
			</div>

			{stage === "questions" && answers.length ? (
				<div className="border-t border-ink/10 p-2">
					<Button variant="ghost" size="sm" className="w-full" disabled={pending} onClick={reviseLastAnswer}>修改上一题</Button>
				</div>
			) : stage === "settings" ? (
				<div className="border-t border-ink/10 bg-paper-100 p-2">
					<Button size="sm" className="w-full" loading={pending || busy} disabled={pending || busy || uploading || universesLoading} onClick={() => void confirmSettings()}>确认设置并开始 {creationModeLabel}</Button>
				</div>
			) : null}
		</div>
	);
}

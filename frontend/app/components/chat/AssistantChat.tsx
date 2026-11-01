import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/Button";
import { SvgIcon } from "~/components/ui/SvgIcon";
import { projectQueryKeys } from "~/query/queryKeys";
import { chatApi } from "~/services/api";
import type { ChatItem } from "~/types";
import { toast } from "~/utils/toast";
import "~/components/ui/icons/workbenchIcons";

interface AssistantChatProps {
	projectId: number;
	/** Mobile summary: render nothing until there is a conversation. */
	hideEmpty?: boolean;
}

function Bubble({ item }: { item: ChatItem }) {
	if (item.role === "tool") {
		return (
			<li className="flex items-center gap-1 text-xs text-ink-muted" data-chat="tool">
				<SvgIcon name={item.ok ? "check" : "triangle-alert"} size={12} className={item.ok ? "text-primary" : "text-warning-fg"} />
				<span className="font-semibold">{item.tool}</span>
				{item.text ? <span className="truncate">· {item.text}</span> : null}
			</li>
		);
	}
	const mine = item.role === "user";
	return (
		<li className={clsx("flex", mine && "justify-end")} data-chat={item.role}>
			<div
				className={clsx(
					"select-text whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 text-sm",
					mine ? "ml-8 bg-primary/10 text-ink" : "mr-8 border border-line bg-surface",
				)}
			>
				{item.text}
				{item.error ? <p className="m-0 mt-0.5 text-xs text-error-fg">{item.error}</p> : null}
			</div>
		</li>
	);
}

/**
 * The project assistant (ADR 0011). Messages come from the engine's saved
 * conversation; a change the assistant proposes shows as a card and runs only
 * after 确认. Approval gates are never answered here.
 */
export function AssistantChat({ projectId, hideEmpty = false }: AssistantChatProps) {
	const { data } = useQuery({
		queryKey: projectQueryKeys.chat(projectId),
		queryFn: () => chatApi.get(projectId),
		enabled: projectId > 0,
	});
	const [answering, setAnswering] = useState(false);
	const end = useRef<HTMLLIElement>(null);
	const messages = data?.messages ?? [];
	const busy = data?.busy ?? false;
	const pending = data?.pending ?? null;

	useEffect(() => {
		end.current?.scrollIntoView?.({ block: "end" });
	}, [messages.length, data?.text, pending]);

	const answer = async (approved: boolean) => {
		if (!pending) return;
		setAnswering(true);
		try {
			await chatApi.confirm(projectId, pending.tool_call_id, approved);
		} catch {
			toast.error({ title: "操作没有提交", message: "这个确认可能已经失效" });
		} finally {
			setAnswering(false);
		}
	};

	if (hideEmpty && messages.length === 0 && !busy) return null;

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-shell="assistant-chat">
			<ul className="m-0 min-h-0 flex-1 list-none space-y-2 overflow-y-auto p-3" aria-live="polite">
				{messages.length === 0 && !busy ? (
					<li className="py-6 text-center text-xs text-ink-muted">
						问问项目进度，或让助手重画某一镜、修改大纲。改动前会先请你确认。
					</li>
				) : null}
				{messages.map((item) => (
					<Bubble key={item.id} item={item} />
				))}
				{busy && data?.text ? <Bubble item={{ id: 0, role: "assistant", text: data.text }} /> : null}
				{busy && !data?.text && !pending ? (
					<li className="flex items-center gap-1.5 text-xs text-ink-muted" role="status">
						<span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden="true" />
						助手在想…
					</li>
				) : null}
				{pending ? (
					<li className="rounded-lg border border-primary/40 bg-primary/5 p-2.5" data-testid="chat-confirm">
						<p className="m-0 text-xs font-semibold text-primary">{pending.tool} · 需要你确认</p>
						<p className="m-0 mt-0.5 text-sm">{pending.summary}</p>
						<div className="mt-2 flex justify-end gap-1.5">
							<Button size="sm" variant="ghost" disabled={answering} onClick={() => void answer(false)}>
								取消
							</Button>
							<Button size="sm" disabled={answering} onClick={() => void answer(true)}>
								确认
							</Button>
						</div>
					</li>
				) : null}
				<li ref={end} aria-hidden="true" />
			</ul>
			{busy ? (
				<div className="flex justify-end border-t border-line px-2 py-1">
					<Button
						size="sm"
						variant="ghost"
						className="h-8 min-h-8 gap-1 px-2 text-error-fg hover:bg-error/10"
						onClick={() => void chatApi.abort(projectId).catch(() => undefined)}
						aria-label="停止回答"
					>
						<SvgIcon name="stop" size={14} /> 停止回答
					</Button>
				</div>
			) : null}
		</div>
	);
}

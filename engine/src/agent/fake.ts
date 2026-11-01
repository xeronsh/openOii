/**
 * Scripted reply for the fake text provider, so the chat works offline and in
 * e2e: pick a tool from keywords, then summarise the tool result.
 */
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((block): block is { type: "text"; text: string } => block?.type === "text")
          .map((block) => block.text)
          .join("")
      : "";

function summarise(tool: string, raw: string): string {
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(raw) as Record<string, any>;
  } catch {
    return raw.slice(0, 200);
  }
  if (tool === "get_project_state") {
    const shots = (data.shots ?? []) as Array<Record<string, unknown>>;
    return `项目「${String(data.project?.title ?? "")}」：${(data.characters ?? []).length} 个角色，${shots.length} 个分镜，已出画面 ${shots.filter((s) => s.has_image).length} 个。`;
  }
  if (tool === "get_run_status") {
    const run = data.run as Record<string, unknown> | null;
    return run ? `运行 #${String(run.id)}：${String(run.status)}，当前阶段 ${String(run.current_stage ?? "—")}。` : "现在没有进行中的运行。";
  }
  if (tool === "read_settings") return `文本提供商：${String(data.TEXT_PROVIDER ?? "未设置")}。`;
  return raw.slice(0, 200);
}

/** "重画第 2 镜" / "第2镜重新生成一下" → 2 */
const redrawOrder = (input: string): number | null => {
  if (!/重画|重新生成|重做/.test(input)) return null;
  const match = /第\s*(\d+)\s*[镜个]/.exec(input);
  return match ? Number(match[1]) : null;
};

const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

export function fakeChatReply(context: TranscriptContext): AssistantMessage {
  const last = context.messages[context.messages.length - 1];
  const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
  const order = redrawOrder(lastUser ? text(lastUser.content) : "");
  if (last?.role === "toolResult") {
    const raw = text(last.content);
    if (last.toolName === "regenerate_shot") {
      return fauxAssistantMessage(
        fauxText(last.isError ? `好的，没有重画。${raw.includes("没有确认") ? "" : raw.slice(0, 120)}` : `已开始重画第 ${String(order)} 镜，可以在时间线里看进度。`),
      );
    }
    if (last.toolName === "get_project_state" && order !== null && !last.isError) {
      const shot = ((JSON.parse(raw) as { shots?: Array<{ id: number; order: number }> }).shots ?? []).find(
        (entry) => entry.order === order,
      );
      if (!shot) return fauxAssistantMessage(fauxText(`这个项目没有第 ${order} 镜。`));
      return toolCall("regenerate_shot", { shot_id: shot.id, type: /视频/.test(text(lastUser!.content)) ? "video" : "image" });
    }
    return fauxAssistantMessage(fauxText(summarise(last.toolName, raw)));
  }
  const input = last?.role === "user" ? text(last.content) : "";
  if (order !== null) return toolCall("get_project_state", {});
  if (/批准|通过|审批/.test(input)) {
    return fauxAssistantMessage(fauxText("审批门需要你本人在审批区点「通过」，我不能替你批准。"));
  }
  if (/运行|进度|跑到/.test(input)) return toolCall("get_run_status", {});
  if (/设置|模型|配置/.test(input)) return toolCall("read_settings", {});
  if (/状态|项目|分镜|角色/.test(input)) return toolCall("get_project_state", {});
  return fauxAssistantMessage(fauxText("我可以帮你查看项目状态和运行进度，也可以重画某一镜，直接告诉我就好。"));
}

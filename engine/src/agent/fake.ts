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

export function fakeChatReply(context: TranscriptContext): AssistantMessage {
  const last = context.messages[context.messages.length - 1];
  if (last?.role === "toolResult") {
    return fauxAssistantMessage(fauxText(summarise(last.toolName, text(last.content))));
  }
  const input = last?.role === "user" ? text(last.content) : "";
  if (/批准|通过|审批/.test(input)) {
    return fauxAssistantMessage(fauxText("审批门需要你本人在审批区点「通过」，我不能替你批准。"));
  }
  if (/运行|进度|跑到/.test(input)) return fauxAssistantMessage(fauxToolCall("get_run_status", {}), { stopReason: "toolUse" });
  if (/设置|模型|配置/.test(input)) return fauxAssistantMessage(fauxToolCall("read_settings", {}), { stopReason: "toolUse" });
  if (/状态|项目|分镜|角色/.test(input)) return fauxAssistantMessage(fauxToolCall("get_project_state", {}), { stopReason: "toolUse" });
  return fauxAssistantMessage(fauxText("我可以帮你查看项目状态、运行进度和模型设置，直接问我就好。"));
}

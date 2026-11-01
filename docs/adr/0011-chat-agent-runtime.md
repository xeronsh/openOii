# ADR 0011: 项目对话助手进入 Agent Runtime（pi-agent-core）

- 状态：Accepted（2026-11-01）
- 关联：ADR 0008（engine 是唯一 orchestration runtime）。本 ADR 落实 0008 决策 3 预留的
  「出现真正需要自主 tool-use 的用例时再接线」，并修改 0008 决策 4（ReviewAgent）。

## 背景

工作台的对话入口目前只做一件事：`POST /projects/{id}/runs/feedback` 让 FastAPI 里的
`ReviewAgent` 把一句话分类成「从哪个阶段、对哪些角色/镜头重跑」。它不能回答问题、不能
查询项目状态、不能一次完成多步操作，用户说「第 3 镜太暗，重画一下」之外的话都无法处理。

用户要能对话，助手需要自己判断该用哪个能力、作用于哪个阶段和对象。这正是 ADR 0008 定义的
Agent Runtime 用例：「需要模型自主规划、工具选择和循环执行的局部能力」。

d21a660 曾删除 `@mariozechner/pi-agent-core`：当时它是一个 `tools: []` 的 Agent，只能通过
未文档化的 `stage:"smoke"` 触达，没有真实用例。本次有真实用例，依赖重新引入必须满足下面的约束。

## 决策

1. **对话助手是 engine 里的 pi-agent-core `Agent`**（`@earendil-works/pi-agent-core`，与
   `@earendil-works/pi-ai` 同版本升级）。FastAPI 只做 gateway：鉴权、校验、持久化读取、转发、
   把 engine 事件翻译成 WS 契约。
2. **工具只包装现有的确定性能力**：查询项目/run 状态、读非敏感设置、启动/恢复/取消 run、
   定向重画、重新合成、编辑大纲/角色/镜头（导出暂未做成工具，仍在界面里操作）。工具不复制阶段逻辑；WorkflowRunner 的
   15 个阶段和 6 个审批门仍是 run 状态唯一真相。
3. **所有写操作都需要用户确认**：`beforeToolCall` 拦下每个写工具，生成确认卡片，用户确认后
   才执行；拒绝或超时则把结果作为工具错误交还模型。
4. **审批门只能由人操作**：助手没有「批准」工具；即使模型请求，也只能返回提示让用户在审批区
   操作。
5. **模型**：助手使用当前配置的文本模型，测试只用脚本化的 fake 模型。
6. **会话**：每个项目一个长期会话，消息存 SQLite；WS 只是通知。
7. **退役**：对话入口切到助手后，删除 `ReviewAgent` 分类入口（`/runs/feedback` 的 LLM 分类），
   不保留两条对话路径。

## 约束（来自 d21a660 的教训）

- 每个工具都有生产调用方和测试，没有只为演示存在的入口。
- 配置缺失（prompt、工具名、模型）时直接报错，不用空字符串兜底。
- key 和敏感配置不进入工具结果、事件、日志。
- 对外描述（README、仓库简介）只在功能落地后更新。

## 后果

正：
- 对话可以查询、问答、多步操作，并且每一步对用户可见、可确认、可停止。
- 编排策略仍只有一份（engine），符合 ADR 0008 的五个不变量。

负/注意：
- 多轮对话比一次分类更费 token；用步数上限和精简的状态摘要控制。
- 助手与用户手动编辑可能并发修改同一资源，依赖现有 `revision` compare-and-set，冲突回报给模型。
- pi 1.x 的 `stream`/`getModels` 旧接口位于 `@earendil-works/pi-ai/compat`，该入口被上游标为临时，
  后续需迁到 `createModels()`。

## 实施记录

- P1 #170：升级到 `@earendil-works/pi-ai` 1.4.0（Node ≥ 22.19）。
- P2 #171：engine 内的 pi-agent-core 助手 + 只读工具，会话存 SQLite。
- P3 #172：写工具、`beforeToolCall` 确认卡片、`/projects/{id}/chat` API。
- P4 #173：工作台「助手」标签页：流式回复、停止、确认卡片；输入框的非审批消息发给助手。
- P5：删除 `ReviewAgent`、`/runs/feedback`，以及已无调用方的 Python 图像/视频服务、文本/图像/视频工厂和 `FakeTextService`（fake 文本模型只在 engine 里）；
  旧库中没有执行命令的反馈 run 不再作为可恢复运行出现。
- 收尾：engine 不再用 pi-ai 的临时 `compat` 入口；工作流文本调用、视觉审查、对话助手和 fake 模型共用 `engine/src/pi-models.ts` 里的一个 `createModels()` 注册表（anthropic / OpenAI 兼容 / faux）。

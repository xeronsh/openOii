# openOii PR #9 — Architecture Completion & AI Workbench Redesign Goal

> Status: complete. Phases A–F and the full DoD audit are complete; Workbench layout was visually checked at 1366, 1440, and 1920 px. `git diff --check` passed. Automated tests/build were not run per `AGENTS.md`. Branch: `refactor/pi-only-simplification`.
> Execution rule: 严格按 Phase A → F 顺序执行，不允许跨阶段顺手重构。

---

## 0. Mission

把 openOii 从：

> "一个不断累积功能、前后端都持有部分流程逻辑的 AI 漫剧 Demo"

收敛成：

> **一个以 deterministic workflow engine 为核心、局部 Agent 能力为增强、SQLite 为单机事实源、AI-native Workbench 为主要交互面的创作系统。**

目标不是增加更多 abstraction。

目标是：

**少一层、少一份状态、少一份重复实现、少一种运行路径。**

最终系统应该能用一句话解释：

```text
React Workbench
      │
      │ HTTP / WS
      ▼
FastAPI Product API
      │
      │ run commands / queries
      ▼
openOii Engine
      │
      ├── Workflow Runtime
      │     ├─ stage machine
      │     ├─ approval gates
      │     ├─ retry/resume
      │     ├─ targeted rerun
      │     └─ durable events
      │
      └── Agent Runtime
            └─ only for genuinely open-ended tool-use tasks

             │
             ▼
          SQLite
       single source of truth
```

---

## 1. Architecture principle

### 1.1 不再做 "Multi-Agent 系统"

openOii 不应该继续围绕：

```text
OutlineAgent
PlanAgent
RenderAgent
CriticAgent
ComposeAgent
...
```

作为顶层架构隐喻。

这些大多数实际上只是：

```text
Stage + Prompt + Model/Tool invocation
```

并没有真正的 agent autonomy。

Anthropic 对 workflow 和 agent 的定义很适合 openOii：

* workflow：代码预先决定执行路径；
* agent：模型动态决定自己的执行路径和 tool usage。

因此：

```text
错误：

Agent A
 ↓
Agent B
 ↓
Agent C
 ↓
Agent D

正确：

WorkflowRunner
 ├── Stage: outline
 ├── Gate
 ├── Stage: character planning
 ├── Stage: character render
 ├── Critique loop
 ├── Gate
 ├── Shot render
 └── Compose
```

LLM 是 stage executor。

不是整个系统的 orchestrator。

---

## 2. 保留现在 PR #9 的核心架构

PR #9 目前最值得保留的是：

```text
frontend/
backend/
engine/
```

我不会重新合并它们。

而是把职责进一步冻结。

### frontend

只负责：

```text
Product UI
Server-state projection
Canvas
User intents
Run visualization
Human approval
```

禁止承担：

```text
workflow orchestration
business truth
run truth
stage derivation truth
```

### backend

FastAPI 只保留：

```text
HTTP API
WebSocket gateway
resource CRUD
auth
validation
uploads
exports
configuration
project ownership
engine gateway
```

禁止：

```text
agent loop
workflow transition
stage scheduling
retry policy
resume policy
target orchestration
```

换句话说：

```text
FastAPI should say:
"用户要求重新生成 shot 13"

而不是：

"先调用 RenderAgent，然后 CriticAgent，然后判断是否 rerender"
```

后者应该全部属于 engine。

### engine

Engine 成为：

```text
唯一执行平面
```

包括：

```text
run lifecycle
stage lifecycle
checkpoint
attempt
idempotency
lease
fencing
cancel
resume
approval
critique
target rerun
event log
```

ADR 0008 里的这句应该成为整个 repo 最重要的不变量：

```text
FastAPI 不得决定下一步执行什么。
```

---

## 3. PR #9 下一步最高优先级：彻底删除 Python Agent Runtime

现在处于一种 "80% 迁完" 的状态。

PR 已经明确留下了这些违规：

```text
backend/app/services/agent_runner.py
backend/app/agents/render.py
backend/app/agents/compose.py
LocalRunSpec.agent_plan
```

这个应该成为下一阶段 P0。

不过不能直接删。

因为现在 Python 路径还有：

```text
CHARACTER_IDENTITY_LOCK
style template
character bible
face embedding
```

所以应该先做能力矩阵。

---

## 4. Engine Capability Matrix

新增：

```text
docs/architecture/engine-capability-matrix.md
```

形式：

| Capability                  |  Python | Engine | Required |
| --------------------------- | ------: | -----: | -------: |
| outline                     |       ✓ |      ✓ |        ✓ |
| character planning          |       ✓ |      ✓ |        ✓ |
| shot planning               |       ✓ |      ✓ |        ✓ |
| character rendering         |       ✓ |      ✓ |        ✓ |
| shot rendering              |       ✓ |      ✓ |        ✓ |
| critique                    |       ✓ |      ✓ |        ✓ |
| compose                     |       ✓ |      ✓ |        ✓ |
| style template              |       ✓ |      ? |        ✓ |
| character bible             |       ✓ |      ? |        ✓ |
| identity lock               |       ✓ |      ? |        ✓ |
| face embedding              |       ✓ |      ? |        ✓ |
| targeted character rerender |       ✓ |      ✓ |        ✓ |
| targeted shot rerender      |       ✓ |      ✓ |        ✓ |
| cancel propagation          | partial |      ✓ |        ✓ |
| crash resume                |  legacy |      ✓ |        ✓ |

迁移规则：

```text
只有全部 Required = Engine ✓

才允许删除 Python implementation。
```

这样不会出现为了 "架构好看" 损失生成质量。

---

## 5. Agent Runtime 应该缩小，而不是扩大

现在 engine 已经只依赖 `pi-ai`，没有真正依赖 `pi-agent-core`。

这其实没问题。

甚至建议暂时继续这样。

因为：

```text
pi-ai
+
custom workflow engine
```

非常适合 openOii。

不要因为项目名字里出现 "agent"，就强行：

```text
npm install pi-agent-core
```

ADR 0008 现在对这个问题的判断是对的。

真正值得以后引入 Agent Loop 的地方是这种任务：

### Story Doctor

用户：

> 把这个故事改得更适合 30 秒短视频，但保留人物关系。

模型可以自己：

```text
read outline
read characters
inspect shots
compare pacing
modify outline
modify shots
validate
```

这是 Agent。

### Creative Director

用户：

> 整体画面不够像 90 年代香港电影，帮我调整一下。

模型可能：

```text
inspect style
inspect references
inspect characters
inspect shots
choose affected entities
update prompts
rerender selected entities
evaluate result
```

这也是 Agent。

而：

```text
render_character → critique → approval
```

不是 Agent。

是 workflow。

---

## 6. 不建议现在做 Multi-Agent

尤其不要变成：

```text
Director Agent
Storyboard Agent
Character Agent
Rendering Agent
Critic Agent
Supervisor Agent
```

然后让它们互相聊天。

这会重新走回 LangGraph 那条路。

复杂度变成：

```text
prompt × N
context × N
handoff × N
state × N
debug × N
```

Anthropic 的建议同样是从简单、可组合结构开始，只在复杂度能明确改善效果时增加复杂度。

---

## 7. SQLite：继续用，不要换数据库

对于 openOii 当前规模：

```text
single user
desktop/local-ish
single backend container
single engine sidecar
```

SQLite 是非常合理的。

特别是 WAL 模式允许 reader 与 writer 同时运行；但 SQLite WAL 本质仍然只有一个 writer，因此必须维持 "单机执行平面" 这一假设。

ADR 里的：

```text
SQLite 不假装 distributed database
```

非常重要。

所以现在不要：

```text
SQLite → PostgreSQL
```

也不要：

```text
Redis queue
Kafka
Celery
Temporal
```

openOii 暂时完全不需要。

---

## 8. SQLite 下一阶段应该做的是 "规范化写模型"

而不是换数据库。

建议最终把 runtime tables 收敛为：

```text
projects

runs
run_attempts
stage_attempts
checkpoints

events

characters
shots

artifact_versions

messages
```

核心关系：

```text
Project
  │
  └── Run
       │
       ├── StageAttempt
       ├── Checkpoint
       └── Event
```

其中：

```text
Run
```

是执行实例；

```text
StageAttempt
```

是一次具体 operation；

```text
Event
```

只是发生过什么；

```text
Project / Character / Shot
```

才是最终业务状态。

---

## 9. Durable Events 不等于 Event Sourcing

不要进一步复杂化成 event sourcing。

你的模型应该是：

```text
State = truth

Events = durable notification / audit
```

而不是：

```text
State = replay(events)
```

所以保持 ADR 里的：

```text
DB 是真相
events 是通知
WS 是传输
query 是 projection
```

---

## 10. Frontend 现在比 Backend 更值得重构

从目前 `ProjectPage.tsx` 可以明显看到一个问题：

它已经不再是 Page。

它实际上同时是：

```text
page
run controller
query coordinator
websocket coordinator
feedback controller
canvas selection coordinator
recovery coordinator
export controller
version controller
UI composition root
```

这个应该拆。

不是为了 "clean architecture"。

而是为了让 UI 后面还能继续长。

---

## 11. ProjectPage 最终应该缩到约 100–200 行

目标：

```tsx
<ProjectWorkbench>
  <WorkbenchTopbar />
  <WorkflowRail />
  <Canvas />
  <AgentPanel />
  <Inspector />
  <PromptBar />
</ProjectWorkbench>
```

而数据逻辑进入：

```text
features/project/
features/run/
features/workbench/
```

比如：

```text
features/run/
  api.ts
  queries.ts
  mutations.ts
  useRunController.ts
  useRunEvents.ts
  types.ts

features/project/
  queries.ts
  mutations.ts

features/workbench/
  Workbench.tsx
  WorkbenchShell.tsx
  WorkbenchSidebar.tsx
  WorkbenchInspector.tsx
```

---

## 12. React Query 和 Zustand 的边界必须重做

PR 自己已经指出：

> frontend store 仍镜像 server data。

这个建议直接解决。

原则：

### React Query

拥有：

```text
projects
characters
shots
runs
messages
versions
config
```

这些属于 server state。

### Zustand

只拥有：

```text
selectedNodeIds
sidebarOpen
sidebarTab
panel sizes
canvas viewport
runMode draft
modal state
local preferences
```

也就是：

```text
UI state only
```

不再：

```text
projectStore.project.name
projectStore.characters
projectStore.shots
projectStore.run.progress
```

服务器已有的字段不要复制一遍。

---

## 13. WebSocket 也不要 patch Zustand

推荐：

```text
WS event
   ↓
Event normalizer
   ↓
queryClient.setQueryData()
   ↓
React Query
   ↓
UI
```

而不是：

```text
WS
 ↓
zustand
 ↓
react-query
 ↓
component local state
```

现在这种多层同步很容易出现：

```text
哪个才是真的？
```

---

## 14. Run 应该有一个独立客户端模型

建议：

```ts
interface RunView {
  id: number
  status:
    | "idle"
    | "queued"
    | "running"
    | "awaiting_approval"
    | "recoverable"
    | "failed"
    | "cancelled"
    | "succeeded"

  stage: WorkflowStage | null
  progress: number
  currentOperation?: string
  error?: RunError
}
```

然后：

```text
useCurrentRun(projectId)
```

成为唯一入口。

不要组件自己组合：

```text
currentRunId
isGenerating
recoveryControl
awaitingConfirm
currentStage
progress
```

这些实际上是同一个状态机。

---

## 15. 前端视觉：不要把五个网站 "混搭"

这五个参考站应该分工。

它们不是五套 theme。

### beautifului.dev

它最值得抄的不是颜色，而是 **AI interaction primitives**。

Beautiful UI 已经专门围绕 AI-native interface 做：

```text
Thinking
Streaming Text
Approval Card
Tool Chips
Task Rows
Context Cards
Diff Table
Agent Screen
Prompt Bar
```

这些和 openOii 高度契合。

openOii 应该重点借：

```text
Agent Activity
Thinking
Tool Execution
Approval
Streaming
Context
```

---

## 16. beUI

beUI 现在已经明显偏向：

```text
animated product UI
+
AI agent UI
```

而且有：

```text
Agent Activity
Message Bubble
Prompt Input
Tool Result
Approval Card
AI Sidebar
Streaming Response
```

非常适合作为交互实现参考。

但不要直接全装。

建议：

```text
copy → simplify → normalize → own
```

---

## 17. Rare UI

Rare UI 的作用应该是：

> 让极少数关键交互有 personality。

而不是所有组件都 animated。

它强调独特、精致的小型 animated primitives，并且采用类似 shadcn 的源码分发方式。

openOii 可以用在：

```text
generation completion
mode switch
asset reveal
selection interaction
empty state
```

不要用在：

```text
every button
every card
every dropdown
```

否则会很吵。

---

## 18. transitions.dev

这个应该成为 openOii 的 **motion grammar**。

它提供的是：

```text
card resize
number pop
menu
modal
tabs
toast
streaming text
skeleton → content
error shake
success
```

而且整体基于统一 motion token 设计。

建议 openOii 定：

```css
--motion-fast: 120ms;
--motion-normal: 180ms;
--motion-slow: 280ms;

--ease-out: cubic-bezier(...);
--ease-spring: ...;
```

然后所有 UI 都遵守这套 motion language。

---

## 19. shadcn/ui

shadcn 最值得借的是 architecture。

不是 "长得像 shadcn"。

它的核心思想是：

```text
open code
composition
beautiful defaults
AI-readable components
```

组件源码属于项目自己，而不是依赖一个巨大黑箱 UI package。

这非常符合 openOii。

因此建议：

```text
不要迁 Next.js。

保持：
React
Vite
TypeScript

但采用 shadcn-style component architecture。
```

---

## 20. 前端依赖建议

现在：

```text
React 18
Vite
Tailwind 3
DaisyUI
Heroicons
tldraw
React Query
Zustand
```

目标状态：

```text
React
Vite
TypeScript
Tailwind

React Query
Zustand

tldraw
Motion

Radix/Base UI style primitives
Lucide
```

然后逐步移除：

```text
DaisyUI
```

DaisyUI 是现在视觉统一最大的隐患之一。

因为已经有自己的：

```text
DESIGN.md
tokens
Button
Card
workbench
CMYK visual language
```

继续让 DaisyUI 的：

```text
btn
card
modal
base-100
base-200
```

参与设计系统，会形成两套 design language。

---

## 21. 但不要把 openOii 变成灰白 SaaS

这是非常重要的一条。

现在已经形成了：

```text
comic
CMYK
ink
paper
workbench
```

这种产品 identity。

不要为了参考 shadcn / Beautiful UI：

把它重构成：

```text
黑白
rounded-xl
gray-950
border-gray-200
Inter
```

那会失去 openOii。

正确方案应该是：

```text
shadcn 的 architecture
+
Beautiful UI 的 AI interaction
+
beUI 的 motion
+
Rare UI 的少量 personality
+
Transitions.dev 的 motion rules
+
openOii 自己的 visual identity
```

---

## 22. 新的 UI 核心隐喻

建议彻底从：

```text
Dashboard
```

切换到：

```text
AI Creative Workbench
```

主项目页面布局：

```text
┌──────────────────────────────────────────────────────────┐
│ openOii / Project         Stage     Run       Export      │
├──────────────┬──────────────────────────────┬─────────────┤
│              │                              │             │
│ Agent /      │                              │ Inspector   │
│ Activity     │          Canvas              │             │
│              │                              │ selected    │
│ thinking     │         tldraw               │ item        │
│ tool calls   │                              │ settings    │
│ approvals    │                              │ versions    │
│              │                              │             │
├──────────────┴──────────────────────────────┴─────────────┤
│  Ask openOii…                                     ↑      │
└──────────────────────────────────────────────────────────┘
```

这比现在：

```text
sidebar + stage + random panels
```

更有产品心智。

---

## 23. 左侧不应该只是 Chat

把它改成：

```text
Activity
```

内部可出现：

```text
You
Director
Workflow
Render
Critic
System
```

例如：

```text
● Story structure
  Generated 3-act outline
  8.2s

● Character design
  Rendering Lily
  Flux 1.1 Pro
  18.4s

● Critique
  Identity consistency 8.7/10

◉ Waiting for your approval
```

用户应该可以一眼知道：

```text
AI 在干什么
为什么在干
完成了什么
现在等我干什么
```

这正是 Beautiful UI / beUI 那类 AI-native interface 最值得借的地方。

---

## 24. Stage Pipeline 也应该弱化

不要一直占一大条：

```text
规划 → 角色 → 分镜 → 渲染 → 合成
```

可以改为紧凑的：

```text
Story
Characters
Shots
Render
Video
```

运行时显示：

```text
Render · Character 3/4
```

真正细粒度的：

```text
critique_character_images
render_shots
compose_merge
```

属于 activity。

不应该让普通用户理解 engine topology。

---

## 25. Canvas 是第一公民

openOii 最特殊的东西不是 Chat。

而是：

```text
AI + infinite visual canvas
```

所以应该让 Canvas 占：

```text
70–80%
```

空间。

Agent UI 只是辅助 Canvas。

未来用户应该能：

```text
选中角色
→ "换成短发"

选中三个镜头
→ "这三格光线统一一点"

圈一个区域
→ "重新生成这里"
```

然后：

```text
selection
→ context chip
→ prompt
→ targeted run
```

这应该成为 openOii 的核心 UX。

---

## 26. Prompt Bar

底部做一个 persistent Prompt Bar。

状态变化：

### 无选中

```text
Ask openOii to change the story...
```

### 选中角色

```text
[ Lily × ]  把衣服改成黑色夹克
```

### 多选 shots

```text
[ 3 shots × ]  统一成夜景
```

### workflow 等待 approval

```text
Looks good?
[Continue] [Request changes...]
```

一个组件承载：

```text
prompt
feedback
approval
targeted editing
```

而不是散落在多个 panel。

---

## 27. Inspector

右边 Inspector：

```text
Selection
Properties
Generation
History
```

而不是新开大量 drawer。

例如选中 Shot：

```text
Shot 07

Preview

Prompt
Camera
Lighting
Character
Seed

Generation
Model
Aspect Ratio

Versions
v4 current
v3
v2
```

---

## 28. AI transparency

用户不需要看 chain-of-thought。

但需要看：

```text
step
tool
result
status
duration
```

例如：

```text
Generating character references
  ✓ Loaded character bible
  ✓ Applied visual style
  ✓ Generated image
  ● Checking identity consistency
```

这叫：

```text
operational transparency
```

而不是展示模型私有 reasoning。

---

## 29. Error UX 必须升级

PR 已经修了：

```text
HTTPException detail
vs
error object
```

下一阶段应该做统一 error contract：

```ts
type ApiError = {
  code: string
  message: string
  retryable: boolean
  context?: unknown
}
```

Engine 侧：

```text
ProviderTimeout
ConcurrentModification
ExecutionLeaseLost
GenerationRejected
RateLimited
```

Backend 转换成稳定 error code。

Frontend 不再：

```ts
error.message.includes("409")
```

这种判断。

---

## 30. Frontend architecture target

建议最后形成：

```text
frontend/app/

  app/
    router.tsx
    providers.tsx

  components/
    ui/

  features/
    project/
    run/
    workbench/
    canvas/
    activity/
    prompt/
    inspector/
    assets/
    versions/
    settings/

  query/

  services/

  styles/
    tokens.css
    motion.css
    globals.css
```

而不是继续：

```text
components
pages
stores
hooks
utils
```

全部横向堆。

feature-based 更适合现在规模。

---

## 31. Backend architecture target

```text
backend/app/

  api/
  models/
  schemas/

  services/
    projects/
    assets/
    exports/
    providers/

  engine_gateway/
    client.py
    commands.py
    events.py

  db/
```

最终：

```text
agents/
```

目录大概率应该消失。

只留下：

```text
review classifier
prompt assets
```

可以改名：

```text
ai/
```

比如：

```text
ai/
  review.py
  prompts/
```

这样不会让未来 contributor 错以为：

> FastAPI 是 Agent Runtime。

---

## 32. Engine architecture target

建议：

```text
engine/src/

  workflow/
    contract.ts
    runner.ts
    stages/
    gates/
    retry.ts
    recovery.ts

  ai/
    llm.ts
    prompts/
    operations.ts

  agent/
    runtime.ts
    tools.ts
    types.ts

  media/

  persistence/
    runs.ts
    attempts.ts
    events.ts
    checkpoints.ts

  domain/

  server/
```

现在 `pipeline/` 可以慢慢改名为：

```text
workflow/
```

因为这个名称更准确。

---

## 33. Stage implementations 也应该拆

现在：

```text
agents/index.ts
```

仍然在强化 "每一步都是 agent" 的错误概念。

建议改：

```text
workflow/stages/

planOutline.ts
planCharacters.ts
planShots.ts
renderCharacters.ts
renderShots.ts
critique.ts
composeVideos.ts
composeMerge.ts
```

统一 contract：

```ts
interface Stage<I, O> {
  id: StageId
  execute(ctx: StageContext, input: I): Promise<O>
}
```

WorkflowRunner 负责调用。

---

## 34. Prompt architecture

Prompts 不要再和 Agent class 绑定。

建议：

```text
engine/prompts/

story/
  outline.md
  character.md
  shots.md

render/
  character.md
  shot.md

critic/
  image.md
```

再通过：

```ts
PromptDefinition
```

加载。

以后非常适合做：

```text
prompt version
prompt eval
A/B
```

---

## 35. Agent Skills

未来如果真的引入 autonomous Agent，更倾向：

```text
general agent
+
skills
```

而不是：

```text
10 permanent agents
```

Anthropic 的 Agent Skills 本身也是把领域知识、脚本和资源包装成可发现、可组合能力，而不是不断产生更多长期角色 Agent。

例如：

```text
skills/
  cinematic-lighting/
  manga-storyboarding/
  short-video-pacing/
  character-consistency/
```

这和现有 skill 概念还能自然统一。

---

## 36. Contract SSOT

现在 workflow contract 已经开始生成，这是对的。

继续维持：

```text
one source
→ generated engine contract
→ generated frontend contract
```

不要：

```text
Python enum
TS enum
frontend enum
```

三边维护。

但是没必要把整个 OpenAPI / schema 全部 codegen 化。

保持 KISS。

只 codegen 那些：

```text
高漂移成本
+
多 runtime 共用
```

的 contract。

---

## 37. Observability

现在已经有：

```text
run
stage
provider span
```

这应该继续。

未来 debug 一个任务应该可以回答：

```text
Run 981
 ├─ outline             3.8s
 ├─ characters          7.2s
 ├─ render_character   24.1s
 │    └─ fal            23.4s
 ├─ critique            2.8s
 └─ ...
```

并关联：

```text
run_id
stage_attempt_id
operation_id
provider_request_id
```

---

## 38. 不做的事情

这个 Goal 里明确禁止：

```text
❌ Next.js migration

❌ Redux

❌ PostgreSQL

❌ Redis

❌ Celery

❌ Kafka

❌ Temporal

❌ LangGraph

❌ Multi-agent supervisor

❌ microservices

❌ event sourcing

❌ design system npm package

❌ copy five UI sites wholesale

❌ rewrite everything
```

---

## 39. Implementation phases

PR #9 后半段拆成 6 个 milestone。

### Phase A — Runtime convergence

完成：

```text
Engine capability parity
Python render migration
Python compose migration
identity lock migration
character bible migration
style template migration
face embedding migration
```

然后删除：

```text
agent_runner.py
render.py
compose.py
LocalRunSpec.agent_plan
task_manager orchestration
```

完成标准：

```text
所有 generation path 都进入 engine。
```

### Phase B — State contract cleanup

完成：

```text
React Query owns server state
Zustand owns UI state
WS writes React Query
one RunView
one workflow contract
typed engine errors
```

删除：

```text
duplicated project store server fields
duplicated run state
manual status mapping
```

### Phase C — Workbench shell

只做结构，不做花哨动画：

```text
Workbench
├── Topbar
├── Activity rail
├── Canvas
├── Inspector
└── Prompt bar
```

确保：

```text
desktop
1366
1440
1920
```

都稳定。

### Phase D — AI-native interactions

参考 Beautiful UI + beUI：

```text
thinking state
activity rows
tool/result rows
approval card
streaming response
context chips
run status
```

Beautiful UI 本身就是围绕这些 AI-native primitives 设计的。

### Phase E — Motion system

参考 transitions.dev：

```text
modal
drawer
tabs
toast
card resize
streaming
loading → content
success
error
```

只建立：

```text
motion tokens
```

不要 animation everywhere。

### Phase F — Visual polish

最后才用：

```text
beUI
Rare UI
```

增加少量 personality。

不要在架构没稳定前就做大量视觉 polish。

---

## 40. Definition of Done

```text
[x] FastAPI 没有 agent loop
[x] FastAPI 没有 workflow decision
[x] 所有 generation run 都由 engine 执行
[x] Python / TS 不存在同能力双实现
[x] SQLite 是唯一 runtime state truth
[x] WS 只负责 notification
[x] React Query 是 server-state truth
[x] Zustand 只存 UI state
[x] ProjectPage 不再是 god component
[x] workflow contract 单一来源
[x] targeted rerun 统一走 engine
[x] cancel 可以穿透所有 provider
[x] run 可 crash/resume
[x] user edits 不会被 stale engine writes 覆盖
[x] UI 能明确展示 AI 当前操作
[x] Canvas 是主要工作区
[x] selection → prompt → targeted run 成为核心交互
[x] design language 不依赖 DaisyUI
[x] motion 使用统一 token
[x] UI 保留 openOii 自己的 comic/workbench identity
```

---

## 最终结构

```text
openOii

├── frontend
│   └── AI Creative Workbench
│
├── backend
│   └── Product API / Engine Gateway
│
├── engine
│   ├── Workflow Runtime
│   ├── AI Operations
│   ├── Media
│   └── optional Agent Runtime
│
└── SQLite
    └── Project + Runs + Attempts + Events
```

而不是：

```text
Frontend
  ↓
FastAPI Agent
  ↓
Engine Agent
  ↓
LLM
```

---

## 结论与优先级

**是该重新设计，但不是 "三层全部推倒重写"。**

PR #9 Phase 1 已经完成基础设施去复杂化；Phase 2 就把这条路线彻底做完。

优先级：

**① 先完成 Engine 收敛 → ② 删除 Python agent runtime → ③ 清理前端 state architecture → ④ 重构 Workbench 布局 → ⑤ 最后做 Beautiful UI / beUI / Rare UI / transitions.dev 这一层的视觉和交互。**

前端尤其不能只用一句 "参考这五个网站优化 UI" 让 coding agent 自由发挥——那最后大概率会变成各种漂亮组件拼盘。应该明确要求：

> 参考这些站点的 interaction pattern，而不是复制它们的 visual identity。shadcn 用于组件架构，Beautiful UI 用于 AI-native interaction，beUI 用于高质量 motion primitive，Transitions.dev 用于 motion grammar，Rare UI 只用于极少数 signature interactions。保留 openOii 自己的 Comic Workbench 视觉语言。

执行 PR #9 时严格按 Phase A → F 顺序，不允许跨阶段顺手重构，避免再次膨胀成一个 200 文件同时乱动的 mega-PR。

---

## References

1. Anthropic — Building Effective AI Agents: <https://www.anthropic.com/engineering/building-effective-agents>
2. SQLite — Write-Ahead Logging: <https://www.sqlite.org/wal.html>
3. Beautiful UI — primitives for AI-native interfaces: <https://www.beautifului.dev/>
4. beUI — Animated Components for React and Next.js: <https://beui.dev/>
5. Rare UI — Rare Animated React Components: <https://www.rareui.com/>
6. Transitions.dev — UI transitions for AI agents: <https://transitions.dev/>
7. shadcn/ui — The Foundation for your Design System: <https://ui.shadcn.com/>
8. Anthropic — Equipping agents for the real world with Agent Skills: <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>

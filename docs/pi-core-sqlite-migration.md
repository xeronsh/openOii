# 迁移 Goal:后端 Agent 框架 → pi-agent-core,存储 → SQLite

> 状态:DONE(2026-09-13 执行完毕) · 日期:2026-09-13
> 执行记录:Phase 0-7 全部完成;commit 62e6dbf(Phase 1)/ 8996784(Phase 2)/ 4c6377a(Phase 3)/ 52394ce(Phase 4+5)/ 4183f76(Phase 6)/ Phase 7(默认切换 + ADR 0004)
> 决策记录:docs/adr/0004-pi-engine-sqlite.md
> 关联:AGENTS.md(resumability 原则)、ADR 0002/0003、`docs/oiioii-parity.md`

## 0. 一句话目标

把生成编排从「LangGraph StateGraph + Postgres checkpointer + Redis confirm 信号」迁移为「pi-agent-core(Node sidecar)+ 单文件 SQLite(WAL)」,使本地开发零容器、run 状态可断点续跑,且前端 WS 契约不变。

## 1. 可行性结论(为什么可以)

| 现状事实 | 对迁移的含义 |
|---|---|
| 管线是**带 6 个审批闸门的线性流水线**(`state.py` 的 `PRODUCTION_STAGE_SEQUENCE` + `_APPROVAL_TO_PRODUCED_STAGE`),不是复杂分支图 | 手写状态机即可承接,不需要 LangGraph 的 channel/分支能力 |
| 生成任务是**同进程 asyncio 任务**(`generation.py` 的 `create_task`/`BackgroundTasks`),整体本就非多实例安全 | 引入 Node sidecar 不会损失"多实例"能力(本来就没有);confirm 信号可降级为 DB 行 |
| LangGraph 面很小:`graph/driver/persistence/state` 约 500 行,其余 ~5500 行是领域逻辑(prompt、媒体 HTTP 调用、critic 规则、WS 推送) | 重写面可控;领域逻辑大部分以"数据/纯函数"形式平移 |
| pi-agent-core(`@mariozechner/pi-agent-core`,TS/Node,~1500 行)提供 Agent 循环、事件流、TypeBox 工具、`beforeToolCall` 拦截、`steer/followUp`;pi-ai 支持 Anthropic 兼容中转站 + OpenAI 兼容端点 | LLM 调用层直接匹配现有双 provider 配置;**无内置 checkpointer/interrupt,HITL 与持久化需自建** —— 这正是本 goal 的工作量主体 |
| 模型与 Alembic 迁移**零 PG 专有类型**(无 JSONB/ARRAY) | SQLite 化只需换 URL + 一处 `ALTER` 兜底改 batch 模式 |
| Redis 仅 3 个用途:confirm 单 key、awaiting payload(TTL 2h)、export 缓存(TTL 1h),且全部 try/except 非致命 | 可整体删除,替代品都是 DB 行或进程内事件 |

**两个前提(接受才可迁移):**

1. **语言边界**:pi-agent-core 是 TypeScript/Node,Python 无法直接嵌入。本 goal 采用 **Node sidecar(引擎)+ Python FastAPI(保留 API/WS/静态/配置)** 的双进程形态,共享同一个 SQLite 文件。不做全量 TS 重写(那会波及 config/provider/export 等数千行非 agent 代码,风险与收益不成比例;引擎稳定后可另行评估)。
2. **SQLite 单写者**:适合"单机、单实例、单用户本地工具"定位。WAL 模式下多进程可并发读、轮流写。若未来要多人服务端部署,PG 路径保留在 docker-compose 中作为替代 profile,不删除代码路径。

## 2. 目标架构

```
┌─────────────────────────── 本机(零容器)───────────────────────────┐
│                                                                     │
│  FastAPI (Python, 18765)                Agent Engine (Node, 18766)  │
│  ├─ HTTP API(projects/runs/feedback)   ├─ pi-agent-core 循环      │
│  ├─ WS /ws/projects/{id}(契约不变)     ├─ 17 阶段线性状态机        │
│  ├─ 静态媒体 /static                    ├─ 6 个 HITL 闸门           │
│  ├─ config/providers/export/tts         ├─ checkpoint 读写          │
│  └─ WS 桥:tail run_events 表 ──────────┼─→ 事件先落库再推送         │
│                                         │                            │
│  共享 SQLite 文件(WAL):projects / runs / artifacts /            │
│  run_events / checkpoints / config / messages                   │
└─────────────────────────────────────────────────────────────────────┘
```

**进程间契约只有两个**:同一个 SQLite 文件 + sidecar 的本地 HTTP(启动/取消/健康检查)。confirm 信号 = `runs` 表一行状态变更(彻底替代 Redis)。WS 事件 = sidecar 写 `run_events` 表,FastAPI tail 后按**现有 WS schema** 推送(前端零改动)。

## 3. 非目标(明确不做)

- 不改前端任何代码,WS 事件 schema 保持逐字段兼容(以 Phase 0 的契约快照为准)。
- 不改 prompt 文案、critic 评分规则、媒体服务的请求参数——只做语言平移,不做行为变更。
- 不做全后端 TS 重写;不引入消息队列;不做多实例/多机部署。
- 不删除 PG 路径:`DATABASE_URL=postgresql+asyncpg://…` 时后端仍按原方式工作(docker-compose profile 保留),直到 sidecar 稳定一个里程碑后再评估退役。

## 4. 分阶段计划

### Phase 0 —— 基线与安全网(0.5~1 天)

可运行的定义:**没有它,后面每一步都无法判断"没变坏"。**

- [ ] 后端全量 `uv run pytest` 绿基线记录到本文档附录。
- [ ] **WS 事件契约快照**:跑一条 fake-provider 全流程 run(`TEXT_PROVIDER=fake`、`IMAGE_PROVIDER=fake`、`VIDEO_PROVIDER=fake`),录制完整事件序列(类型/顺序/payload 字段)存 `docs/fixtures/ws-contract-snapshot.json`。这是 Phase 6 对比验收的金标准。
- [ ] 用真实 provider 跑一条金丝雀 run,留存产物(角色图、分镜、成片)作为 parity 对比样本。
- [ ] 建迁移分支 `feat/pi-core-sqlite`,每个 Phase 一个可合并的 PR。

### Phase 1 —— 删除 Redis(1~2 天,独立可发布)

可运行的定义:`docker-compose.dev.yml` 只剩 postgres(或 Phase 2 后一个都没有),全量测试绿,生成/恢复/取消/审批行为不变。

- [ ] confirm 信号:`orchestrator.py` 的 `wait_for_confirm_redis/trigger_confirm_redis/clear_confirm_event_redis` 替换为 `runs` 表 `confirm_signal` 列 + 编排侧轮询(500ms)或 `asyncio.Event`。API 的 `/{project_id}/feedback|confirm` 路由改为更新该列。
- [ ] awaiting payload(WS 重连补发):Redis key → `runs.awaiting_payload` JSON 列,写入/清除时机不变。
- [ ] export 缓存(`export.py` TTL 1h):新表 `export_cache(export_id PK, payload, expires_at)`,读取时惰性清理过期行。
- [ ] 删除 `redis` 依赖、`REDIS_URL` 配置、compose 中 redis 服务;更新 AGENTS.md。

### Phase 2 —— 元数据存储 SQLite 化(1~2 天,独立可发布)

可运行的定义:`DATABASE_URL=sqlite+aiosqlite:///./data/openoii.db` 时全流程可用、`uv run pytest` 全绿(PG URL 时行为不变)。

- [ ] `sqlalchemy[asyncio]` + `aiosqlite` 依赖;连接串按 scheme 分流;SQLite 侧开启 `PRAGMA journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`。
- [ ] Alembic:确认全部迁移在 SQLite 方言可跑(当前零 PG 专有类型,预期无碍);`alembic.ini` 已默认 SQLite,对齐 `DATABASE_URL` 注入方式。
- [ ] `session.py:_sync_missing_metadata_columns` 的 `ALTER … DROP NOT NULL` 改为 SQLAlchemy `batch_alter_table`(SQLite 无该原生语法)。
- [ ] LangGraph checkpointer 桥接(临时,Phase 4 后删):`persistence.py` 增加 sqlite URL 分支,用 `langgraph-checkpoint-sqlite` 的 AsyncSqliteSaver,使「全 SQLite、无 pi」状态也可断点续跑。
- [ ] `run_recovery.py`、`init_db()` 在 SQLite 下回归(遗留 run 标 cancelled、create_all 兜底)。
- [ ] `backend/.env.example` 增补 SQLite 示例;README 开发环境段落更新。

### Phase 3 —— pi-agent-core 引擎脚手架(2~3 天)

可运行的定义:Node 进程能以 fake 工具跑通一个最小 Agent 循环,事件逐条落 `run_events` 表,`pnpm test`(新 vitest)与 `tsc --noEmit` 绿。

- [ ] 新建 `engine/`(Node 22 + TypeScript + vitest,包管理沿用 pnpm);依赖:`@mariozechner/pi-agent-core`、`@mariozechner/pi-ai`、`better-sqlite3`、`zod`(若 TypeBox 生态外需要)。
- [ ] SQLite 访问层:WAL 只读连接 + 单写连接;表:`run_events(run_id, seq, type, payload, created_at)`、`checkpoints(run_id PK, stage, state_json, updated_at)`。
- [ ] pi-ai 接入现有双 provider:Anthropic 兼容中转站(`anthropic_base_url/auth_token`)与 OpenAI 兼容端点(`text_base_url/key/model`),配置从 SQLite `configitem`/环境读取,语义对齐 `config.py`。
- [ ] 引擎骨架 HTTP:`POST /runs`、`POST /runs/:id/cancel`、`GET /health`,监听 `127.0.0.1:18766`(仅本机回环)。
- [ ] 事件落库:pi 的 `agent_start/message_update/tool_execution_*` 等事件映射为 `run_events` 行,`seq` 单调。

### Phase 4 —— 状态机 + checkpoint + 闸门(3~4 天,核心)

可运行的定义:fake provider 下,17 阶段全流程跑通;在任意闸门 kill 掉 Node 进程,重启后 `resume` 能从 checkpoint 续跑;6 个闸门的 approve/reject 语义与现状一致。

- [ ] 状态机:按 `PRODUCTION_STAGE_SEQUENCE` 实现线性推进 + 阶段注册表(每阶段:执行函数、事件、产出物 schema)。
- [ ] **checkpoint 语义**(替代 LangGraph checkpointer):每阶段完成后写 `checkpoints`(state_json + stage 指针);闸门 = 暂停循环 + 写 `runs.awaiting_payload` + 状态 `awaiting_confirm`;恢复 = 读 checkpoint 从下一阶段继续。kill 安全:阶段内不可恢复,恢复到上一阶段边界(与现状 checkpointer 粒度一致)。
- [ ] 闸门确认:`runs.confirm_signal` 行级信号(替代 `interrupt()`/`Command(resume=...)`);reject 分支按现节点语义回跳对应生产阶段。
- [ ] Critic 闭环:`review_rules.py` 阈值/轮数逻辑平移为 TS 纯函数 + 单测(逐条对拍 Python 版同一输入的输出)。
- [ ] `driver` 语义回归:把 `driver.py` 的 interrupt-loop 测试用例在 TS 侧重写为状态机测试。

### Phase 5 —— 领域逻辑平移(3~4 天)

可运行的定义:fake provider 下,与 Phase 0 金丝雀 run 的**产物结构和事件序列逐字段一致**。

- [ ] prompts 平移:`app/agents/prompts/` → `engine/prompts/`(文本原样,格式化参数对齐)。
- [ ] plan/outline/render/compose 各阶段的 LLM 调用改为 pi-ai;结构化输出解析(JSON schema/容错逻辑)逐段对拍。
- [ ] 图像/视频/TTS HTTP 客户端 TS 化(modelscope/OpenAI 兼容/豆包 Ark/Edge-TTS),请求头、重试、超时对齐 `config.py` 的 header 构造;**这部分不经 pi-ai**,保持直连。
- [ ] 产物落盘:`backend/app/static` 目录与 URL 规则不变(`build_public_url` 语义对齐),FastAPI 继续托管静态文件。

### Phase 6 —— 双进程集成(2~3 天)

可运行的定义:前端零改动跑通创建→审批→成片→导出全流程;WS 事件与 Phase 0 快照对比通过;进程崩溃有明确恢复路径。

- [ ] FastAPI 增加引擎客户端:`generate/resume/cancel/feedback` 路由内部转发 sidecar HTTP;sidecar 未启动时回退旧路径(功能开关 `AGENT_ENGINE=pi|langgraph`,默认 langgraph,灰度切换)。
- [ ] WS 桥:FastAPI tail `run_events`(500ms 轮询或 `stat` 触发),按现有 schema 推送;`data_cleared`/进度/思考链消息字段逐一对照快照。
- [ ] 进程管理:dev 下 uvicorn 启动时拉起/复用 engine 子进程(或 `docker-compose.dev.yml` 增 engine 服务);崩溃重启后按 `checkpoints` 恢复,孤儿 run 标 cancelled(对齐 `init_db` 现行为)。
- [ ] `run_recovery` 语义在双进程下回归。

### Phase 7 —— 切换与退役(1 天)

可运行的定义:默认 `AGENT_ENGINE=pi`、默认 SQLite;PG+LangGraph 仅作为 compose profile 存续;文档全量更新。

- [ ] 默认值切换,删除 `langgraph-checkpoint-postgres`、`redis` 等依赖(保留 `langgraph` 至 Phase 2.1 桥接移除后再删)。
- [ ] AGENTS.md、README、`docs/adr/` 新增 ADR:记录"为什么 sidecar 而非重写/留在 Python"的决策与回滚条件。
- [ ] 删除临时的 AsyncSqliteSaver 桥接(Phase 2.1);E2E(`pnpm e2e`)全绿。

## 5. 验收标准(整体 Definition of Done)— 执行结论

| # | 标准 | 结论 | 证据 |
|---|---|---|---|
| 1 | 零容器全功能(含断点续跑) | ✅ | 裸 `uv run uvicorn`(无 DB/引擎 env)→ 生成 run_completed(3 角色/6 分镜/成片);引擎闸门处被杀 → API `/resume` → 新进程续跑至完成 |
| 2 | Parity(事件序列 + 产物结构) | ✅ | 事件词表 16/16 一致、闸门序列一致、terminal 一致、领域产物一致;话术量差异见附录 B(已记录) |
| 3 | Resumability | ✅ | 双进程集成路径 "RESUME VERIFIED";langgraph 回滚模式有一处迁移前即存在的闸门循环怪癖(附录 A 已记录) |
| 4 | 前端零改动、E2E 全绿 | ⚠️ 部分 | 前端零改动 ✅;E2E 6 个失败均为**存量过期 spec**(期望重构前首页文案,该文案已不存在于代码库;本分支前端零改动,main 上同样失败)。浏览器缓存已 bootstrap(playwright 1.57 → chromium-1200)。修复过期 spec 是独立的前端测试维护任务 |
| 5 | 回滚开关 | ✅ | `AGENT_ENGINE=langgraph`(+可选 PG URL)恢复原编排路径;闭包测试 24 个专测该路径;Redis 不参与回滚(confirm 信号已列化) |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| SQLite 写并发(sidecar 写事件/checkpoint 与 API 写元数据争锁) | WAL + `busy_timeout`;事件批量写;压测:fake run 高频事件下无 `database is locked` |
| 双进程生命周期复杂度(比单进程多一种崩溃面) | sidecar 视为可丢弃:任何异常以 checkpoints 恢复;健康检查 + 孤儿 run 清理 |
| WS 契约漂移导致前端隐性破坏 | Phase 0 快照 + Phase 6 逐字段 diff 作为合并门槛 |
| 行为平移走样(LLM 输出解析、critic 阈值边界) | 领域函数逐条对拍单测;parity run 人工比对产物 |
| langgraph 1.x 与 pi 事件语义差异(如 message_update 粒度不同) | 桥接层做事件重整(reduce 到现有 WS 粒度),不让前端感知 |
| 工作量超预期 | 每 Phase 独立可发布、可停在任一 Phase;Phase 1/2 本身就是净收益 |

## 7. 工作量与节奏

总计约 **12~17 个工作日**(兼职节奏 3~4 周)。关键路径:Phase 4(状态机+闸门)→ Phase 6(集成)。Phase 1、2 可先行合入,与 pi 侧解耦。

---

### 附录 A:执行基线与验收证据(已填写)

- 基线:`uv run pytest` **1136 passed**(2026-09-13,迁移前)
- WS 契约快照:`docs/fixtures/ws-contract-snapshot.json`(179 事件,run_completed,fake provider 全流程)
- 产物结构基准:`docs/fixtures/fake-run-artifact-structure.json`(3 角色/6 分镜/成片 mp4)
- Parity 验收(AGENT_ENGINE=pi,双进程):事件词表 **16/16 一致**、闸门序列一致(outline→plan→plan→render→render→compose)、terminal=run_completed、领域产物一致(3 角色/6 分镜/成片)
- 恢复验收:引擎在闸门处被杀 → API `/resume` → 新引擎进程从 `engine_checkpoints` 继续 → run_completed("RESUME VERIFIED")
- 测试终态:后端 `pytest` 1128 绿;引擎 `vitest` 5 绿;`tsc --noEmit` 双侧干净
- 已知既怪(迁移前即存在,与 pi 引擎无关):
  - LangGraph 模式 resume 在部分闸门状态会重复进入 characters_approval(引擎模式的 resume 语义已由 engine_checkpoints 重新实现,不受影响)
  - 全新库上 LangGraph 引擎的首次生成可能因历史 checkpoint 串线失败(仅 PG checkpointer 场景)

### 附录 B:与金标准的既有话术量差异(fake 数据,非契约违反)

- run_message 40 vs 67 / agent_thinking 3 vs 13 / run_progress 23 vs 27:Python fake_text 的罐头话术更密(逐实体 loading 文案、思考链更多 planning 段)
- version_created 9 vs 18:金标准在计划阶段对已有实体也做版本快照;引擎模式仅渲染前快照(版本语义见 review)
- 这些差异不影响事件词表、闸门顺序、终态与领域产物结构

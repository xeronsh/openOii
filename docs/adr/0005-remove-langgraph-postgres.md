# ADR 0005: 移除 LangGraph 与 PostgreSQL，pi 引擎成为唯一编排路径

- 状态:Accepted(2026-02-14)
- 关联:`docs/adr/0004-pi-engine-sqlite.md`(前序迁移)、`docs/pi-core-sqlite-migration.md`(迁移执行记录)、AGENTS.md

## 背景

ADR 0004 把生成编排迁到 pi-agent-core sidecar + 单文件 SQLite，但刻意保留了
`AGENT_ENGINE=langgraph` 作为回滚开关，并保留 PostgreSQL checkpointer 路径。
保留期的实际代价持续累积：

- `app/orchestration/{graph,driver,nodes,runtime,persistence}.py` 约 1290 行只服务回滚开关；
  `app/agents/orchestrator.py` 1210 行里大部分是 langgraph 执行体。
- 同一份 stage 契约被抄了四遍：`orchestration/state.py`、`services/run_recovery.py`、
  `engine/src/contract.ts`、`frontend/app/utils/workflowStage.ts`。
- 依赖上背着 `langgraph`、`langgraph-checkpoint-postgres`、`langgraph-checkpoint-sqlite`、
  `asyncpg`、`psycopg[binary,pool]`、`psycopg2-binary` 共 20 个传递包。
- 回滚路径**从未被真正使用**：pi 已是默认值，闭包测试 24 个专测回滚路径，
  但它们测的是一条没人走的分支。
- `run_recovery._checkpoint_history` 早已带 `except: return []` 兜底 —— 结构上承认
  checkpoint 读取不可靠，真正的恢复事实来自 DB 实体。

## 决策

**删除 LangGraph 与 PostgreSQL，pi 引擎是唯一编排路径。** 具体：

1. 删除 `app/orchestration/`（graph/driver/nodes/runtime/persistence）与
   `app/agents/orchestrator.py`；`state.py` 上提为 `app/orchestration.py`（纯 stdlib，
   零 langgraph 依赖），并成为 `PHASE2_STAGE_ORDER` 的权威表。
2. confirm 信号 / awaiting payload / stage→agent 映射移入
   `app/services/run_signals.py`（原在 orchestrator 里，route 与 WS 层都要用）。
3. `services/run_recovery.py` 改为表驱动：完成阶段读引擎的 `engine_checkpoints`，
   实体计数读 `character`/`shot` 表。删掉 snapshot reader。
4. 删除 `AGENT_ENGINE` 开关；`generate`/`resume`/`cancel`/`feedback` 一律经
   `_dispatch_to_engine` 走 loopback HTTP。
5. **`/feedback` 保留功能**：pi 引擎此前没有反馈路由能力（该路由无条件走 langgraph）。
   `ReviewAgent` 保留（无 langgraph 依赖），路由出起始阶段后交引擎从该阶段起跑
   （`PipelineRequest.startStage`）。这是删 langgraph 必须补上的能力缺口，不是新功能。
6. 依赖删除：`langgraph*`、`asyncpg`、`psycopg*`，共 20 个包。
   `onnxruntime` 显式保留（insightface 的运行期后端）。
7. `backend/Dockerfile` 改为多阶段：从 `engine/` 拷 node 与已编译的 better-sqlite3
   进后端镜像（引擎与后端同容器），否则 `ensure_engine_running` 在 Docker 里必然失败。

## 后果

正:
- 单一编排路径，没有"没人走但必须维护"的分支。
- 后端测试从 1128 降到 961（~170 个是专测回滚路径的闭包测试）。
- 20 个依赖包消失；`uv.lock` 明显变薄。
- 恢复语义不再依赖 checkpointer 的 try/except 兜底。
- Dockerfile 自洽：镜像里同时具备 node 与 engine，部署形态与本地一致。

负/注意:
- **不再有存储回退**。PostgreSQL 部署路径消失；需要多实例写入的能力也没有了
  （`task_manager` 仍是进程内的，本来就只单 worker 安全）。
- 阶段契约仍是三份镜像（`app/orchestration.py` 权威 + `engine/src/contract.ts`
  + `frontend/app/utils/workflowStage.ts`）。本轮**没有**引入 codegen；漂移风险靠测试
  断言而非生成器控制。要根除需另立工作。
- `engine/src/prompts.generated.ts`（36KB）仍与 `backend/app/agents/prompts/*.py` 重复，
  且**没有生成器**。本轮未处理。
- 测试新增 autouse guard（`conftest._no_real_engine`）：任何测试都不允许真的拉起
  sidecar 或调外部 LLM。

## 回滚

无。删除是不可逆的：恢复需从 git 历史取回 `app/orchestration/`、`app/agents/orchestrator.py`
与 pyproject 的六个依赖，并把 `AGENT_ENGINE` 分支加回三个 route。ADR 0004 记录的回滚开关
自此失效。

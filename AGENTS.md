# AGENTS.md

## 架构约束（不可协商）

**openOii Engine 是唯一 orchestration runtime。FastAPI 不得决定下一步执行什么。**

- 固定创作流程由 **Workflow Runtime** 决定：`engine/` 的阶段机、审批门、
  重试/恢复、失效计划、lease/fencing、durable events。
- 只有**需要模型自主规划、工具选择和循环执行的局部能力**才进入 **Agent Runtime**。
  17 阶段流水线本质是 workflow，不应该被强行 agent 化。
- FastAPI 的定位只有两个：**Product Backend** 与 **engine 的 northbound
  gateway**。它负责鉴权、校验、持久化 ownership、HTTP/WSS 契约、把请求
  转发给 engine、把 engine 事件翻译成客户端契约；**不负责决定「下一步做什么」**。
- 后端对生成链路的合法动作只有：建 run、下发 plan/指令、读回状态、转发事件。
  如果某个能力确实需要「在 Python 里做 agent 的事」，正确解法是给 engine 加能力，
  不是在 FastAPI 加代码。判据：这段代码是否让 FastAPI 决定「下一步做什么」？

### 五个不变量

- **FastAPI 不做 orchestration。**
- **WorkflowRunner 不假装 Agent。**
- **Agent Loop 不负责确定性业务流程。**
- **SQLite 不假装 distributed database。**
- **WS 不假装 state store** —— DB 是真相，事件是通知，WS 是传输，Query 是投影。

### 已知违规（待清理，新增代码不得模仿）

- `backend/app/services/agent_runner.py` 在进程内跑 agent loop（`run_agent_plan`）。
- `backend/app/agents/render.py`、`backend/app/agents/compose.py` 是被 FastAPI
  直接实例化执行的 agent 实现。
- 调用点：`api/v1/routes/{projects,shots,characters}.py` 构造 agent 列表后经
  `services/run_lifecycle.py` 执行；`services/run_lifecycle.py` 的
  `LocalRunSpec.agent_plan` 这个参数本身就是这个违规的形状。
- 完整的生成链走 engine sidecar（`app/api/v1/routes/runs.py` → `_dispatch_to_engine`），
  这部分是符合约束的参照实现。
- `backend/app/agents/review_rules.py` **不算违规**：它只把反馈分类成 rerun
  起始阶段，不跑 agent loop。

### 清理前置条件（硬门）

删 Python 侧 agent 实现前必须先确认 engine 侧具备这些能力，否则是功能回退：
`CHARACTER_IDENTITY_LOCK`、风格模板、角色圣经、人脸嵌入 —— 目前**只在 Python 侧**。
详见 `docs/adr/0008-orchestration-runtime.md`。

### 部署形态约束

后端镜像把 engine 编进同一个容器（多阶段 Dockerfile），两者必须共享同一个
SQLite 文件；基础镜像固定在 **Node 22**（better-sqlite3 13 的 prebuild 在
Node 20 上 segfault，exit 139 且无 stderr）。

## 开发纪律（本仓已约定）

- **默认不跑测试。** 改完代码就结束，不执行 `pytest` / `vitest` / `pnpm build` /
  `tsc` / `ruff`。只有用户亲口说要跑测试才执行。交付说明里写明「测试未跑」。
- **默认不 push。** 本地提交不推远端，也不触发 CI。push 会重启完整 PR CI
  （Contracts/Engine/Frontend/Backend/Docker）。用户明确要求再 push。
- 不要为避免编译/检查报错而保留废弃字段或死代码；形状变了就把调用点一起改。

## 先看这个
- openOii 是“故事想法 → 漫剧成片”的长链路生成应用；改动生成、恢复、进度推送时，优先保 resumability 和现有执行流。
- **架构边界见本文件顶部「架构约束（不可协商）」**（ADR 0008）：openOii Engine 是唯一 orchestration runtime，FastAPI 只做 Product Backend + northbound gateway。任何新增能力先问它该在哪一层。
- 这是三包仓库，没有根级统一脚本：后端在 `backend/` 用 `uv`，前端在 `frontend/` 用 `pnpm`，生成引擎 sidecar 在 `engine/` 用 `pnpm`（pi-agent-core，TypeScript）。
- 编排引擎只有 pi sidecar 一种：首次触发生成时由后端自动拉起（loopback 18766），共享同一个 SQLite 文件；本地开发零容器。`AGENT_ENGINE=langgraph` 回滚开关已移除（ADR 0004 → 见 `docs/adr/0005-remove-langgraph-postgres.md`）。
- 数据库只有单文件 SQLite（`sqlite+aiosqlite:///./data/openoii.db`，WAL）——PostgreSQL / Redis 均已删除，不再有存储分支。
- 当前 GitHub Actions 只有镜像构建/推送：`.github/workflows/docker-publish.yml`。本地要自己跑测试/构建，CI 不会替你兜底。

## 关键入口
- 后端 FastAPI 入口：`backend/app/main.py`。
- API 聚合：`backend/app/api/v1/router.py`，默认前缀 `/api/v1`。
- 生成链路 HTTP 入口：`backend/app/api/v1/routes/runs.py`。run 是一等资源：`POST /projects/{id}/runs` 创建、`GET /projects/{id}/runs/current` 水合、`POST /runs/{run_id}/resume|cancel` 按 run 寻址、`POST /projects/{id}/runs/feedback` 反馈。
- 真正的编排/持久化逻辑在 `backend/app/orchestration.py` 与 pi sidecar（`engine/`）；API 层只负责建 run、下发/转发、回传控制面——**不得承载 agent loop**（见上「架构约束」）。
- WebSocket 入口：`/ws/projects/{project_id}`。
- 前端入口：`frontend/app/main.tsx`；路由在 `frontend/app/App.tsx`。

## 开发命令

### 后端
```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 18765
uv run pytest
uv run pytest tests/test_api/test_generation.py -q
uv run ruff check app tests
```

### 引擎（pi sidecar，通常由后端自动拉起，手动调试用）
```bash
cd engine
pnpm install
pnpm test            # vitest
pnpm exec tsc --noEmit
ENGINE_DB_PATH=../backend/data/openoii.db pnpm dev   # loopback 18766
```

### 前端
```bash
cd frontend
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm exec vitest run app/pages/ProjectPage.test.tsx
pnpm exec tsc --noEmit
pnpm e2e
pnpm e2e:install
```

### Docker
```bash
cp backend/.env.example backend/.env
docker-compose up -d
docker-compose -f docker-compose.dev.yml up -d
docker-compose logs -f backend
docker-compose down
```

## 验证习惯

- **默认不跑测试。** 改完代码就结束，不执行 `vitest` / `pytest` / `tsc` / `build` /
  `ruff`。下面这些命令是用户亲口说「跑测试」之后才用的。
- 前端：相关 `vitest` → `pnpm build`（含 `tsc`）。
- 后端：相关 `pytest` → 按需全量 `uv run pytest` + `uv run ruff check app tests`。
- 改依赖时同步更新锁文件：`backend/uv.lock`、`frontend/pnpm-lock.yaml`。
- E2E 配置在 `frontend/playwright.config.ts`；它只会自动起前端 `pnpm dev`。测试要打真实 API 时，后端要自己另起。

## 易错点
- `frontend/app/utils/runtimeBase.ts` 会在开发环境按当前页面 hostname 自动推导后端 `18765` 端口，并自动对齐 `localhost`/`127.0.0.1`。默认通常不需要写 `frontend/.env.local`；只有后端不在默认地址时再配 `VITE_API_URL` / `VITE_WS_URL`。
- `backend/app/config.py` 里测试与运行时的配置读取路径不同：测试里直接 `Settings()` 不会自动读仓库 `.env`，运行时走 `get_settings()` 才会加载 `.env`。
- `backend/app/db/session.py:init_db()` 启动时会 `create_all()`、初始化配置、把遗留 `queued/running` run 标成 `cancelled`，并调用 `ensure_postgres_checkpointer_setup()`。改模型/持久化时要同时考虑启动初始化和 Alembic。
- Alembic 版本文件在 `backend/alembic/versions/`，但 `backend/alembic.ini` 默认指向本地 SQLite；跑迁移前先确认 `DATABASE_URL`/环境变量覆盖正确。
- 生成/恢复/取消流程依赖数据库状态、`agentrun.confirm_requested` 信号列和进程内 `task_manager`；不是多实例安全。引擎是独立进程，通过 `agentrun` 列、`engine_checkpoints` 与 `engine_run_events` 表和 Python 侧通信——两边必须指向同一个 SQLite 文件。
- `backend/aiosqlite/` 是刻意的本地 shim（遮蔽 site-packages 的 aiosqlite）：SQLAlchemy 与 engine 的共享库协议都依赖它；原始 sqlite 调用经 asyncio.to_thread 下放，别改回事件循环内同步执行（busy 等待会自死锁）。
- 阶段契约的权威表是 `backend/app/orchestration.py` 的 `PHASE2_STAGE_ORDER`；`engine/src/contract.ts` 与 `frontend/app/utils/workflowStage.ts` 是它的镜像，改一处要同步两处（`test_orchestrator_helpers.py` 与后端测试会各自断言）。
- `backend/Dockerfile` 是多阶段构建：从 `engine/` 拷 node + 已编译的 better-sqlite3 进后端镜像，因为引擎与后端同容器。改 engine 依赖后注意 `engine/pnpm-lock.yaml`。
- `configitem` 表里的运行时配置会覆盖 `.env`；种子逻辑以进程 env 优先（config_service.ensure_initialized）。若后端连了意料之外的库，先查这张表。
- Docker 场景下，若图像/视频服务跑在宿主机，`backend/.env` 里不能继续用 `localhost`；按 README 改成 `host.docker.internal` 或宿主机 IP。
- 静态媒体输出在 `backend/app/static`，Compose 也把这个目录挂出来；改导出/拼接逻辑时不要忽略它。
- `backend/Dockerfile` 会执行 `uv sync --frozen --no-dev --extra agents`；改后端依赖后记得更新 `uv.lock`，并注意运行时会带上 `agents` 可选依赖。

## 测试分布
- 后端测试在 `backend/tests/`，重点是 `test_api/`、`test_orchestration/`、`test_services/`、`test_agents/`，另有 `test_migrations.py` 和 `integration/`。
- 前端单测与组件同目录；E2E 在 `frontend/tests/e2e/`。

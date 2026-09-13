# ADR 0004: 生成编排迁移到 pi-agent-core sidecar + SQLite

- 状态:Superseded by [ADR 0005](0005-remove-langgraph-postgres.md)(回滚开关与 PG 路径已于 2026-02-14 删除)
- 关联:`docs/pi-core-sqlite-migration.md`(迁移 goal 与执行记录)、AGENTS.md

## 背景

迁移前,生成编排 = LangGraph StateGraph(17 阶段线性管线 + 6 个 HITL 闸门)+ PostgreSQL checkpointer + Redis confirm 信号。痛点:本地开发需要起 postgres/redis 容器;configitem 数据库配置会覆盖 `.env`(双重事实来源);Redis 只服务 3 个进程内信号用途;LangGraph 的 channel/checkpointer 能力远超这条线性管线的实际需要。

## 决策

1. **编排引擎迁移到 pi-agent-core**(npm `@mariozechner/pi-agent-core`,TypeScript)。pi 是 TS 运行时,Python 无法嵌入,因此采用 **Node sidecar**(`engine/`,loopback 18766):引擎拥有 run 执行、17 阶段状态机、6 闸门、checkpoint;FastAPI 保留 HTTP/WS/静态/配置/导出,通过 loopback HTTP + 共享 SQLite 与引擎通信。不做全量 TS 后端重写。
2. **存储默认 SQLite**(WAL,busy_timeout,驱动级 autocommit):零容器本地开发。PostgreSQL 路径完整保留(docker-compose 传入 `DATABASE_URL` 即用),`AGENT_ENGINE=langgraph` 保留为回滚开关。
3. **跨进程契约只有两个**:共享 SQLite 文件(`agentrun.confirm_requested`/`awaiting_payload` 列 + `engine_run_events` 表)+ 引擎 loopback HTTP。Redis 已删除(confirm/awaiting/export-cache 全部落库)。
4. **WS 契约不变**:引擎事件落 `engine_run_events`,Python 按连接尾随并经 `ws_manager` 推送;事件词表与金标准快照(`docs/fixtures/ws-contract-snapshot.json`)16/16 一致,闸门序列一致。

## 后果

正:本地开发零容器(`uv run uvicorn` + `pnpm dev` 即全功能,引擎由 API 自动拉起);断点续跑跨进程存活(引擎在闸门处被杀 → API `/resume` → 新引擎从 `engine_checkpoints` 继续);配置单一事实来源(`ensure_initialized` 以进程 env 为准)。

负/注意:
- SQLite 单写者:多进程写依赖 busy_timeout 排队;引擎的 sqlite 调用经 `asyncio.to_thread` 下放线程(busy 等待若阻塞事件循环会自死锁,详见 `backend/aiosqlite/__init__.py` 注释)。
- 引擎与后端必须指向同一个 SQLite 文件(`ensure_engine_running` 自动传递)。
- `backend/aiosqlite/` 是刻意的本地 shim(遮蔽 site-packages 版本),为 SQLAlchemy 与 langgraph-checkpoint-sqlite 提供协议兼容。

## 回滚

~~`AGENT_ENGINE=langgraph` + `DATABASE_URL=postgresql+asyncpg://…`~~ —— **该开关已由 ADR 0005 删除**，不再可用。

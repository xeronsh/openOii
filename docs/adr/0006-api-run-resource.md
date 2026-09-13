# ADR 0006: 接口以 run 为一等资源；错误体统一 envelope

- 状态:Accepted(2026-02-15)
- 关联:ADR 0004/0005(编排收敛到 pi 引擎)

## 背景

编排收敛成 pi 引擎后,后端只剩「HTTP 外壳 + 尾随引擎事件」,但接口形状还留着
多执行体时代的痕迹:

1. **run 不是资源,而是项目动词**。`POST /projects/{id}/generate|resume|cancel|feedback`
   + `GET /projects/{id}/generation-state`。取消/恢复不带 run id,服务端只能
   「查该项目最新的活跃 run」——同项目存在多个 run 时目标不确定。
2. **错误体有两种形状**。`AppException` 走 `{"error":{code,message,details}}`,
   而 `HTTPException`(51 处)走 FastAPI 默认的 `{"detail": str}`。前端只解析前者,
   于是 4xx 的用户可见文案全部静默退化成 `statusText` —— 用户点重绘撞并发锁时
   看到的是「Conflict」而不是「该角色正在重绘」。
3. **路由前缀归属混乱**。13 个路由文件里 10 个不声明 prefix,靠 `router.py`
   逐一挂载;而 `generation.py` 自建 `/projects` 前缀却挂在根上,与 `projects.py`
   的挂载方式不一致。
4. **同一份 WS payload 手拼多遍**。`project_updated` 在 4 处手写,key 集合互不相同。

## 决策

1. **run 是一等资源**:
   - `POST /projects/{id}/runs` 创建(201;409 返回恢复控制面)
   - `GET /projects/{id}/runs/current` 水合当前运行态(可为 null)
   - `POST /runs/{run_id}/resume` / `POST /runs/{run_id}/cancel` 按 run 寻址
   - `POST /projects/{id}/runs/feedback` 反馈(它会路由出起始阶段再建 run)
   `generation.py` 更名 `runs.py`,前端同步拆出 `runsApi`。
2. **错误体唯一形状** `{"error":{code,message,details}}`。为 `HTTPException`
   与 `RequestValidationError` 注册处理器;状态码映射到稳定机器码
   (`CONFLICT`/`NOT_FOUND`/…),前端不必解析中文文案。
3. **裸 dict 响应补 schema**:`cancel`/`feedback` 返回
   `CancelRunResponse`/`FeedbackAcceptedResponse`;`use-in-project` 的多态返回
   显式声明为 `CharacterRead | ShotRead`。
4. **`task_manager` 按 run id 记账**。旧实现以 `project_id` 为键且 `register`
   时主动 cancel 旧任务,于是「先重绘角色 A,再重绘角色 B」会静默取消 A,
   而 A 的 `AgentRun` 行仍是 `running` —— 前端永远等一个不会结束的运行。
   细粒度锁本就允许同项目并行多个局部 run,记账粒度必须跟上。
5. **WS payload 单一来源**:`project_updated` 归 `run_lifecycle.project_updated_event()`;
   前端项目字段归 `store.patchProject()` 的映射表(见下)。

## 后果

正:
- 取消/恢复不再猜目标;并行 run(例如同时重绘两个角色)语义明确。
- 4xx 文案对用户可见;前端可依赖机器码分支。
- 局部 run 的骨架收进 `services/run_lifecycle.py`,3 个 route 各自约 90 行的
  重复消失;`task_manager` 改按 run id 记账(见下)。
- 前端 store 与 WS 的字段映射合成一张 `Record<...>` 表,漏字段是编译错误。

负/注意:
- **破坏性变更**。旧路径(`/generate` 等)不再存在,前端与外部调用方必须同步。
  仓库内已全部迁移,无兼容层 —— 这是刻意的:留着两套路径正是 ADR 0005 删掉的那种成本。
- `task_manager` 仍是进程内状态,多 worker 不安全(与既有假设一致)。
- 未引入分页/过滤的统一约定(列表端点仍返回全量),项目规模下够用,需要时再加。

# 架构现状与 KISS 研究记录

> 本文区分仓库中已有实现、静态审查线索与真实路径验证。静态推演不等于运行复现；未验证项不作为已确认缺陷。运行记录来自各自记录时间的隔离环境，相关路径使用过 fake provider、假媒体或本地 fixture，不代表覆盖当前所有代码版本。

## 当前架构与已实现能力

- FastAPI 负责产品 API、校验和数据所有权；生成编排由 TypeScript workflow engine（`engine/`）持有，FastAPI 不决定生成下一步（`AGENTS.md`）。
- FastAPI 与 engine 共享 SQLite；后端 Alembic 拥有 schema，engine 读共享数据并写运行时 checkpoint/event 数据（`AGENTS.md`、`docs/architecture/engine-capability-matrix.md`）。
- workflow 阶段契约由 `contracts/workflow.json` 生成；engine 有阶段 checkpoint、durable events、stage attempts、lease/fencing 与恢复路径（`engine/src/pipeline/runner.ts`、`engine/src/shared-db.ts`）。
- 已有实现：版本对比抽屉、角色/镜头定向重跑、Engine 阶段 checkpoint 与恢复。完整持久化命令可验证后定向恢复会跳过已提交目标。旧 run 缺少 `execution_command` 时，仅当代码能证明它是尚未执行的普通 full run（`current_agent=orchestrator`、无 `resource_type`/`patch_plan`，且没有 Engine event、checkpoint 或 user message）才兼容恢复；构造的旧命令固定为 `auto_mode=false`。其他缺失命令、畸形命令或无法证明原始范围的旧 run 会拒绝恢复；并非所有旧 run 都可恢复（`engine/src/index.ts:292-358, 414-475`）。
- 历史隔离 HTTP 记录曾验证普通与定向恢复，以及 fake provider 端到端；不等于当前所有版本或真实媒体商路径验证。详见下文。

## 静态审查线索（不是已确认缺陷）

| 审查线索 | 涉及文件 | 已知代码事实与未验证问题 |
|---|---|---|
| 访谈状态在中断或重入时的恢复 | `frontend/app/pages/HomePage.tsx:52-55`、`frontend/app/components/chat/CreationInterviewPanel.tsx:75-84`、`backend/app/api/v1/routes/text.py:23-30` | 新建流程先创建 project，回答提交时按 `project.id` 保存；生成访谈问题的请求不带 `project_id`，但这不足以证明项目关联丢失。未验证中断、切换或重入后访谈状态能否完整恢复。 |
| 取消请求何时完成 | `backend/app/api/v1/routes/runs.py`（`cancel_run`、`_reconcile_active_candidate`）、`backend/app/db/session.py`、`engine/src/pipeline/runner.ts` | 后端持久化取消意图，`cancelling` 是等待执行器确认的中间状态。fake provider 下已端到端验证：Engine 在线时取消后数十毫秒内进入 `cancelled`；无 live lease 时由后端同步终态化；Engine 在 `cancelling` 期间退出时，run 保持 `cancelling` 直到 lease 过期（最长 120 秒），随后由 reconciliation 置为 `cancelled`（此前会被误置为 `failed`）。真实 provider 下的长时间阻塞未验。 |
| 实体 ID 审批的授权边界 | `backend/app/api/v1/routes/shots.py`、`backend/app/api/v1/routes/characters.py`、`backend/app/api/deps.py:23-31` | 审批/重生成路由只接收实体 ID，project 由实体推导，不存在“路径 project + 他项目实体”的组合；`update_shot` 的 `character_ids` 已校验属于同一 project，reorder、版本比较按 project 过滤。未发现跨项目越权路径；用户/项目级权限不在当前范围。 |
| 定向恢复是否进入预期执行分支 | `backend/app/api/v1/routes/runs.py:529-545`、`engine/src/index.ts:230-285`、`engine/src/pipeline/runner.ts:330-336, 731-773` | 隔离 HTTP 路径曾验证定向恢复，fake image provider 控制中断、并手动清空隔离租约后恢复成功；真实 provider 与自然租约到期未验。当前代码对旧 run 缺失命令仅兼容可证明尚未执行的普通 full run，并以 `auto_mode=false` 恢复；其余无法证明原始范围的旧 run 拒绝恢复。完整命令仍须通过格式与目标校验；这不是对所有旧 run 或所有定向恢复的验证。 |
| 新产物失败时旧产物是否仍可用 | `backend/app/services/creative_control.py`、`backend/app/api/v1/routes/shots.py`、`backend/app/api/v1/routes/characters.py`、`backend/app/api/v1/routes/projects.py` | 隔离副本已实跑：分镜重生成失败时旧图片、视频、音频引用及文件保留；成功重生成写入新视频引用，版本回滚恢复旧引用。覆盖范围见“本轮实施与未解决风险”。 |
| 多条终态写入路径的一致性 | `backend/app/api/v1/routes/runs.py`、`backend/app/services/run_recovery.py`、`engine/src/pipeline/runner.ts`、`engine/src/shared-db.ts`、`engine/src/index.ts` | 成功、失败、取消及恢复 reconciliation 涉及多条状态写入路径。run/project 状态、事件和 lease 清理的组合结果尚未逐路径验证。 |

## 外部实践及本仓对应处

以下仅记录研究来源明确指出的实践与仓库中的对应实现；不表示已移植外部代码或做过运行验证。

- [Slate](https://github.com/coracoo/Slate)：其 `storyboard.json` 关联剧本、镜头、素材与视频参考包。对应本仓已有的镜头角色绑定及前后镜头/角色参考图组合（`engine/src/agents/index.ts:694-730`）；可借鉴呈现镜头与参考素材的关系，不另建真相数据源。
- [AI Video Production Editor](https://github.com/LudwigKienle/ai-video-production-editor)：研究分镜、连续性审阅、镜头重拍和后期编辑的工作台组织。对应本仓版本对比抽屉（`frontend/app/components/panels/VersionCompareDrawer.tsx:11-16, 48-85`）与角色/镜头定向重跑（`engine/src/invalidation.ts:53-95`）。来源标注 GPL-3.0；这里只作实践参考，不搬用代码。
- [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo)：研究脚本、素材、字幕、背景音乐的合成与导出流程。对应的合成能力已由 Engine 覆盖（`docs/architecture/engine-capability-matrix.md:9-25`）；不据此替换现有角色一致性或分镜编排。来源标注 MIT。
- [ComfyUI](https://github.com/Comfy-Org/ComfyUI)：节点图可用于表达图像/视频生成参数；若有本地模型需求，可评估作为媒体服务被调用。对应的架构边界是工作流时机、审批和恢复仍由 Engine 决定（`engine/src/pipeline/runner.ts:310-325`）。来源标注 GPL-3.0；未评估部署与集成。
- [BeautifulUI](https://www.beautifului.dev/) 的 Approval Card、Task Rows、Prompt Bar 可作为审批、生成进度和反馈输入的局部交互参考；可对照 `frontend/app/components/chat/ChatPanel.tsx:40-84` 与 `frontend/app/components/layout/StagePipeline.tsx:19-36`。状态仍应来自 run 数据。来源许可页为 [MIT](https://www.beautifului.dev/license)，移植代码需保留许可与版权声明。
- [beui.dev](https://beui.dev/) 的 Agent Todo List 可供任务列表动效参考；本仓 React 18、Tailwind 3（`frontend/package.json:23-25, 44-45`），官网说明面向 React 19、Tailwind 4、Motion，因此不直接安装。来源代码仓许可证为 [MIT](https://github.com/starc007/ui-components/blob/main/LICENSE)，Pro 另行收费。
- [RareUI](https://www.rareui.com/) 作为动画视觉参考，与本仓 Dense Comic Workbench 取向（`DESIGN.md:115-117`）不完全相同；其 [许可](https://github.com/swamimalode07/rare-ui/blob/main/LICENSE)含署名及再销售/再分发限制，不据此复制组件。
- [Transitions](https://transitions.dev/) 可按需参考单个过渡；本仓已有动效时长及减少动画偏好（`frontend/app/styles/tokens.css:80`、`frontend/app/styles/globals.css:297-308`）。其[条款](https://transitions.dev/terms.html)限制将完整库或实质部分重新打包为竞争性库，部分内容为 Pro。
- [shadcn/ui](https://ui.shadcn.com/docs) 可在缺少基础组件能力时参考组件组合与无障碍实践；本仓已有 `Button`、`Modal`，其中 `Modal` 已处理 Escape、焦点和对话框语义（`frontend/app/components/ui/Modal.tsx:12-75`）。本仓 Tailwind 3 与安装文档示例 Tailwind 4 有适配差异；许可见[源码许可](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)。

## 本轮实施与未解决风险

- **重生成旧媒体保护已验证**：隔离副本中分镜重生成失败时，旧图片、视频、音频引用和文件均保留；成功重生成后写入新视频引用，HTTP 版本回滚可恢复旧引用。角色图 fake 重生成成功。Engine 不可用时接口返回 `503`，run 留在 `queued`。记录：`/tmp/openoii-regeneration.KBNq0e/report.md`。
- **共享文件不删除已验证**：删除临时项目后，另一项目共用的媒体文件仍存在。此结论只覆盖该真实隔离路径；当前没有引用计数清理机制。
- **已登记媒体的保守回收**：Engine 产出的图片、视频登记在 `media_object` 的 `managed-v1` namespace。后端启动时（`backend/app/main.py` lifespan，`init_db` 之后）执行一次 mark-and-sweep（`backend/app/services/file_cleaner.py:sweep_managed_media`）：扫描数据库所有表所有列中出现的 `managed-v1/<文件名>` 字符串作为引用（覆盖业务字段、版本快照、run context、stage attempt、checkpoint/event，不逐类建模）；只删除已登记、登记超过 24 小时、无任何引用且解析后仍位于 `STATIC_DIR` 内的文件，并删除对应登记行。任一 run 处于活动状态或持有未过期 lease 时整轮跳过。未登记的旧文件从不删除。只在启动时运行：长期不重启的进程不会回收，这是有意的最小实现。
- **恢复与 fake 端到端已验证**：普通 fake run 在 checkpoint 后被强制终止，`POST /api/v1/runs/3/resume` 返回 `200` 并最终 `succeeded`。定向恢复的隔离 HTTP 路径也成功：已提交目标不重复生成，目标外 shot 保持原引用；均不证明真实 AI/provider 恢复。隔离环境中的实际默认 fake 视频路径已成功，run 状态为 `succeeded`；产物为 H.264/AAC、4.5 秒，已登记且静态 URL 返回 HTTP 200。更早使用本地 MP4 fixture 的路径也已成功。
- **反馈分类路径已删除（ADR 0011）**：`/runs/feedback`、`ReviewAgent` 和 `feedback-classifier` 租约都已退役，对话改由 engine 里的项目助手处理。旧库里没有拿到执行命令的反馈 run 不再作为可恢复运行出现（`_legacy_feedback_run`）。
- **WorkBuddy 文本全流程已实跑**：隔离项目使用临时 DeepSeek `high` 配置，run `1` 成功并产生 1 个镜头及图片、视频产物记录；TTS/BGM 关闭。上游实际收到的请求报文未核实，因此只能确认配置和完整流程结果，不能确认 provider 请求参数。图片、视频均为 fake，不是模型生成证据。临时凭据、数据库、媒体和截图产物已清理；记录：`/tmp/acp-delegate/del_mvrieu7f_w993.out`。

### 媒体下载与回收边界

- 远程视频只接受无凭据的 HTTP/HTTPS URL，DNS 结果必须全部是公网 IP；每次重定向都会重新解析和校验。单个视频最多 `1 GiB`、整个合并最多 `2 GiB`、最多 `100` 个视频，按顺序下载（`backend/app/services/remote_video.py`、`backend/app/services/video_merger.py`）。DNS 查询（同步 `socket.getaddrinfo()`）在后台线程中执行并受剩余下载期限约束（单次最多 30 秒），超时即失败；卡住的线程为 daemon，不阻塞进程退出。
- `/static` 直接由 FastAPI `StaticFiles` 提供；已登记媒体的 URL 可公开读取，登记本身不提供访问控制，也不能撤回已复制或缓存的 URL。真实视频商/provider 下载与生成未验证；本轮视频证据来自本地 fixture/fake provider。

### 主要旧媒体路径安全风险

- 旧文件名可能跨项目共享：Engine fake 图/视频、九宫格及合并输出存在确定性命名，合并还可能覆盖目标；按项目删除或路径猜测会误删仍被引用的文件。共享文件路径验证仅证明当前没有误删，不能推出自动回收安全。
- 不能仅查当前实体字段：`ArtifactVersion` 快照、run context、stage attempt、checkpoint/event 可能继续保存旧 URL；回滚和恢复会再次使用它们。因此回收按全库字符串扫描判断引用，而不是按当前实体字段。
- 旧 URL 到本地文件的映射需保守：`backend/app/services/file_cleaner.py` 只接受以 `/static/` 开头的路径，并在解析后检查路径仍位于 `STATIC_DIR` 内；回收沿用该边界检查，指向目录外的登记（如符号链接）不会被删除。
- 历史上传目录有路径差异：`projects.py` 上传写入 `backend/app/api/static/references`，而 `/static` 挂载指向 `backend/app/static`（`backend/app/main.py`）；旧文件扫描、迁移不能按 URL 推断文件存在位置。
- 回收仅依赖登记表、宽限期和活动 run 检查做并发保护；未登记的旧共享文件（确定性命名、跨项目共用）不在回收范围内，仍保留。

## 范围与未验证项

- 代码事实按本次编辑时查看的仓库源码核对；本文所列运行证据来自各自记录时间的隔离环境。相关路径使用过 fake provider、fake 媒体或本地 fixture，只能说明当时对应隔离环境的结果，不能宣传为覆盖当前所有代码版本或真实媒体商/provider。
- 本次未运行测试。未验证真实图片/视频商、真实 provider 下的恢复/取消、并发准入竞态及 Node 22 恢复路径。
- 外部实践及许可描述以以上链接和研究记录为依据；本文未独立复核当前版本或许可法律适用性。

## 仓库内参考

- `AGENTS.md`：FastAPI / Engine 边界及共享 SQLite 约束。
- `docs/architecture/engine-capability-matrix.md`：Engine 能力范围。
- `contracts/workflow.json`：阶段契约来源。
- 本文“静态审查线索”表中列出的代码路径：对应待核查流程。
- `frontend/package.json`：React / Tailwind 版本。
- `DESIGN.md`：工作台设计方向。
- `frontend/app/query/applyServerEvent.ts:94-108`：`applyServerEvent(queryClient: QueryClient, projectId: number, event: WsEvent): void` 将 WebSocket 事件应用到查询缓存；本文未验证其真实 UI 路径。

> 测试未跑。

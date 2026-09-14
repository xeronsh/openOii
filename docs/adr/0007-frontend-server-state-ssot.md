# ADR 0007: 前端服务端状态归一到 TanStack Query；Zustand 只留客户端状态

- 状态:Accepted(2026-02-20)
- 关联:ADR 0006(接口重构)

## 背景

PR 收尾时,前端同时存在两份「服务端状态」:

1. `editorStore`(Zustand)镜像了 34 个业务字段,其中 23 个是服务端权威数据
   (project 的 20 个字段、`characters`、`shots`、`blockingClips`)。
2. TanStack Query 也在缓存同一批数据(`project` / `characters` / `shots`)。

两份副本靠 WS 事件与页面水合手工对齐,已经产生实际缺陷:

- `project_updated` 曾用 19 项手写映射表,而 payload 有 21 个字段 —— `skill_id`
  被静默丢弃,直到有人逐字段核对才发现。
- 字段映射散落三处(Zustand setter、WS 映射表、ProjectPage 两次 19 行拷贝),
  每次加字段都要改三处。
- `ProjectPage` 在切项目时要手写一份「全 null」的 patch 去清空第二份副本。

## 决策

1. **唯一服务端状态源是 TanStack Query**。`appQueryClient`(app 级单例)同时被
   HTTP 查询与 WS 投影使用,见 `app/query/client.ts`。
2. **唯一 WS → 服务端状态入口是 `applyServerEvent()`**
   (`app/query/applyServerEvent.ts`)。`character_*` / `shot_*` /
   `shots_reordered` / `data_cleared` / `outline_updated` / `project_updated` /
   `audio_generated` / `run_awaiting_confirm`(outline gate)/
   终态 run 事件全部只写 query cache。
3. **Zustand 只保留客户端状态**:画布/角色选中、消息流、运行 UI 态
   (`isGenerating` / `currentStage` / `currentAgent` / `progress` /
   `awaitingConfirm` / `recoveryControl` / `recoverySummary` / `currentRunId` /
   `currentRunProviderSnapshot` / `runMode`)。
4. `applyWsEvent()` 只做上面这类的投影;`ProjectPatch` /
   `PROJECT_PATCH_FIELDS` / `patchProject` / `setCharacters` / `setShots` /
   `updateCharacter` / `updateShot` / `removeCharacter` / `removeShot` /
   `setProjectUpdatedAt` 全部删除。
5. 组件直接从 Query 读:`ProjectPage`、`ComicWorkflowCanvas`、
   `WorkflowInspector`、`TopBar`(`UniverseChip`)、`cardActions`。
   后者渲染在 tldraw 内部拿不到 React context,因此写 app 级 `appQueryClient`。
6. `blocking_clips` 作为 project 的瞬态字段进入 `Project` 类型,由
   `project_updated` 写入、由 run 终态事件清空。

## 后果

正:
- 加一个 project 字段只需改后端 schema 与前端类型,不再有第二处映射表。
- 切项目不再需要手写清空 patch:query key 自带 projectId 作用域。
- `projectUpdatedAt → invalidateQueries` 这条手工桥被删除:WS 已经直接改 cache。
- 前端测试从 449 降到 443(`useWebSocket.test` 少 25 例,
  `editorStore.test` 少 2 例),减少的是断言第二份副本的重复用例;
  同一批契约改为在 `applyServerEvent.test.ts` 针对 query cache 断言。

负/注意:
- 消息流仍在 Zustand(它由 WS 追加、启动时从 HTTP 水合一次),是目前唯一
  带服务端来源但未进 Query 的状态。要合并需先统一「WS 追加 + 分页加载」语义。
- tldraw shape 内部不能用 hook,`cardActions` 直接操作 `appQueryClient`,
  这是一处刻意的例外,已在该文件注释说明。
- WS 必须同时调用 `applyServerEvent`(query)与 `applyWsEvent`(UI),
  顺序由 `useWebSocket` 固定:先 cache,后 UI。

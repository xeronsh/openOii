# OiiOii ↔ openOii 功能差距与复刻路线

> 状态：Phase 0–5a + redesign **已完成**（编排已由 LangGraph 迁至 pi 引擎，见 ADR 0004/0005）；**仅保留 3 个常用简单 Skill**（厚 directives/template/pipeline），拉片等复杂流下线；Review 局部重做已修目标推断与清理范围
> 原则：复刻 **产品原语**，不 1:1 抄 UI / 不追闭源模型护城河；复杂实验流不做。

## 产品原语对照

| 原语 | OiiOii 2.0（公开） | openOii 现状 | 目标 |
|------|-------------------|--------------|------|
| Agent 团队流水线 | ~7 类专家接力 | Outline/Plan/Render/Compose/Critic | 保留并扩展场景/艺术总监角色 |
| 无限画布 | 智能画布，素材可点选唤 Agent | tldraw comic-workflow | 选中绑定对话 + 局部重做 |
| Skill 库 | 行业工作流可挂载 | 6 个简单 Skill + 厚 directives | 只做简单可跑通工作流 |
| 拉片复刻 | 上传视频 → 约 18 维拉片 | **不做**（产品面已移除） | 近端明确非目标 |
| 托管 / 对话 | 两种模式 | review / quick | 产品化文案与入口 |
| 资产复用 | 角色/IP 资产 | Universe + Asset + StyleTemplate | 强化跨项目 |
| 成片合成 | 视频 + BGM + 剪辑 | compose + audio | 产品化导出 |

## 分阶段

| Phase | 范围 | 状态 |
|-------|------|------|
| 0 | 差距文档 + 设计对齐 | ✅ |
| 1 | 首页 Skill 墙 + 项目页导演台布局 + token 收紧 | ✅ |
| 2 | 画布选中 ↔ Agent 上下文 + feedback_entity feedback | ✅ |
| 3 | Skill schema + catalog API 驱动编排入口 | ✅ **深度**：`Project.skill_id` 持久化、directives 注入 outline/plan、默认镜头数/模式 |
| 4 | 拉片复刻 | ❌ **产品下线**：catalog/UI/API 已卸；仅保留历史 DB 字段与遗留 service |
| 5a | 九宫格分镜 + 单格重做 | ✅ **深度**：多选批量重做、排序重排 order、`entity_ids` 多格反馈 |
| 宇宙 | IP 宇宙章节 + 共享角色 | ✅ **深度**：自动导入共享卡司、outline/render 宇宙上下文、提升/导入/编辑 UI |
| 5b | 场景 Agent / 真视频上传多模态 / 画布图编 | 默认不做 |

### 编排架构（2026 对齐；原 LangGraph 段已随 ADR 0005 删除）

- 编排只在 pi 引擎：`engine/src/pipeline/runner.ts` 的 17 阶段状态机
- HITL：闸门写 `agentrun.awaiting_payload`，确认经 `agentrun.confirm_requested` 列
- 断点续跑：每阶段完成写 `engine_checkpoints`，`/resume` 从下一阶段继续
- Skills（仅 3 个常用简单流）：`story-anime` / `character-design` / `quick-short`  
  - 每 skill：`directives` + `story_template` + `pipeline_hints` + 入口 stage/agent  
  - 注入 outline/plan system prompt；创建 时回填默认 style/镜头数/模式  
  - Review：自由文本可解析角色名/镜头号为 target_ids；局部清理不误伤未选实体  

- Selection：review `target_ids` → orchestrator cleanup/render 局部重跑  
  - 反馈语义路由：对白/设定 → plan；画面/光色 → render；运镜/视频 → compose  
  - resume 继承 `project.skill_id`；compose/render 注入实体反馈

## 明确不做（近端）

- 像素级复制 OiiOii 官网 UI
- 闭源视频模型供应链与积分体系
- 运营级 200+ 风格 / 全量行业 Skill 库存
- 完整移动端导演台
- **拉片复刻 / 真视频上传 / 产品广告等复杂实验工作流**
- 只有 catalog 名没有 directives/template 的薄壳 Skill

## 前端信息架构（Phase 1）

```
Home
  导演问候 + 一句话开工
  Skill / 模板墙（配置驱动）
  最近入口：项目 / 资产 / 宇宙

Project（导演台）
  TopBar + StagePipeline
  ┌ Agent Rail │ Canvas │ Workspace Sidebar ┐
  │ 任务/阶段   │ tldraw │ Chat / Inspector  │
  │ 选中上下文  │        │ Assets            │
  └────────────┴────────┴───────────────────┘
```

## Design Read

- **Page kind:** 创意生产工具（canvas-first product UI）
- **Audience:** 独立漫剧创作者
- **Vibe:** Comic Workbench（印刷工位 × 导演台）
- **Dials:** VARIANCE 6 / MOTION 4 / DENSITY 6
- **Anti-slop:** 禁止紫渐变 AI 默认、禁止冷灰 SaaS 三栏照搬

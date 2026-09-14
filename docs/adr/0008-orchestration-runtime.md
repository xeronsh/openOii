# ADR 0008: openOii Engine 是唯一 orchestration runtime

- 状态:Accepted(2026-02-20)
- 关联:ADR 0004/0005(编排收敛到 pi 引擎 + SQLite)、ADR 0006(run 为一等资源)
- 取代:早先的「单一 Agent Runtime」表述（原标题含 Pi Core）

## 约束（不可协商）

**openOii Engine 是唯一 orchestration runtime。FastAPI 不得决定下一步执行什么。**

1. 固定创作流程由 **Workflow Runtime** 决定:`engine/` 的阶段机、审批门、
   重试/恢复、失效计划、lease/fencing、durable events。
2. 只有**需要模型自主规划、工具选择和循环执行的局部能力**才进入 **Agent Runtime**。
   17 阶段流水线本质是 workflow —— 它**不应该**被强行 agent 化。
3. FastAPI 只有两个身份:**Product Backend** 和 **Pi Runtime 的 northbound
   gateway**。合法职责是鉴权、请求校验、schema 契约、资源 ownership 与持久化、
   HTTP/WSS 端点、把请求转发给 engine、把 engine 事件翻译成客户端契约。
4. 五个不变量:
   - **FastAPI 不做 orchestration。**
   - **WorkflowRunner 不假装 Agent。**
   - **Agent Loop 不负责确定性业务流程。**
   - **SQLite 不假装 distributed database。**
   - **WS 不假装 state store** —— DB 是真相,事件是通知,WS 是传输,Query 是投影。
5. 若某能力确实需要在 Python 侧做 agent 工作,正确解法是**给 engine 加能力**,
   不是往 FastAPI 加代码。判据:这段代码是否让 FastAPI 决定「下一步做什么」?

## 背景

长期表述把 Pi Core 说成唯一 Agent Runtime。但实测依赖里**没有**
`@mariozechner/pi-agent-core`,只有 `@mariozechner/pi-ai`;PR 本身也删掉了
`pi-agent-core`。真实形态是:

```text
pi-ai                    ← 模型调用（不是 agent 框架）
+ engine/src/pipeline/   ← 自写的确定性 workflow engine
```

Anthropic《Building Effective Agents》明确区分两者:固定、可预测的任务适合
predefined workflow;只有真正需要模型自主决定工具与路径的部分才适合 agent loop。
17 阶段本质是固定流程:

```text
outline → approve → characters → approve → shots → approve
→ render → critic → compose
```

它不需要模型自己规划下一步。因此**不为了名义上的「Pi Core」把
`pi-agent-core` 塞回依赖** —— 那是把一个 agent 框架加进一个不需要它的地方。

## 决策

1. 用「openOii Engine 是唯一 orchestration runtime」取代旧表述。Workflow Runtime
   是默认形态;Agent Runtime 是**按需的局部能力**,不是系统的核心隐喻。
2. 违反约束的 Python 侧 agent 实现按以下顺序清理(不在本 ADR 内完成):
   1. 先确认 engine 侧具备 `CHARACTER_IDENTITY_LOCK`、风格模板、角色圣经、
      人脸嵌入 —— 这些目前**只在 Python 侧**,是清理的硬前置门。
   2. 迁移完成后删除 `services/agent_runner.py`、`agents/render.py`、
      `agents/compose.py`,并把 `LocalRunSpec.agent_plan` 改成对 engine 的指令描述。
   3. `agents/review_rules.py` **不算违规**:它只把反馈分类成 rerun 起始阶段,
      不跑 agent loop。
3. `engine/src/agent/` 只定义 Agent Loop 的**类型化接缝**(接口 + tool registry +
   step budget + AbortSignal 传播),由测试驱动验证,**不接入产品 pipeline**。
   等出现真正需要自主 tool-use 的用例时再接线。
4. 清理完成前,`AGENTS.md` 的「已知违规」清单是权威登记处,新增/删除同步更新。

## 后果

正:
- 表述与真实实现一致:不再声称一个不存在的 Agent Runtime。
- FastAPI 的可替换性成立:它只描述产品语义,不含编排策略。
- 编排只有一份实现,消除 Python/TS 双侧 parity 维护成本与漂移缺陷
  (critic system prompt 为空、WS 丢 `skill_id` 都出自这类重复)。
- 进程内 `task_manager` 的单 worker 限制随 agent loop 一起消失。

负/注意:
- Agent Runtime 接缝在接入前是**未被产品使用的能力面**;没有真实用例时它的价值
  仅是可演进的边界,不是功能。
- 迁移前,局部重绘路径与主链路走两套运行时,模型/provider 配置、重试与恢复语义
  **仍会不一致**(ADR 0005 遗留项第 4 条的同一根因)。
- 删 Python 实现前若未确认 engine 侧的质量能力,就是功能回退。这是迁移的前置
  条件,不是可选项。

## 附:本 ADR 同时冻结的 correctness 契约

同一轮把这些从「声称」变成「可证」:

1. **crash/replay 身份**:`beginStageAttempt` 不再用实时 DB 重算的 `input_hash`
   做匹配键。阶段开始先冻结 input snapshot 并持久化,resume 按
   (run_id, stage, 非终态 attempt) 复用原身份;只有显式 rerun / feedback
   invalidation 才产生新 attempt。
2. **取消穿透**:每个 run 一个 `AbortController`,贯穿 LLM(`pi-ai` 的
   `signal`)、image/video fetch、provider 退避等待与 doubao 轮询。取消不再只
   在阶段边界生效。
3. **并发写**:`project`/`character`/`shot` 加 `revision` + compare-and-set。
   engine 用它读到的快照 revision 写,陈旧写 affected rows=0 并抛
   `ConcurrentModificationError`,不再静默覆盖用户的 HTTP 编辑。
4. **状态与事件原子**:`emitter.commit()` 在**一个** SQLite transaction 内完成
   「改业务状态 + append durable event」,消除两者之间的崩溃窗口。

## Context

SQLite 已经是 Conversation、Run、Message 和 ToolResult 的唯一事实源。`tool_calls` 会在 Connector 返回后先提交 completed ToolResult，`runs` 则在最终助手消息写入时才进入 `completed`，因此二者之间天然存在一个可恢复的稳定提交点。当前缺口不是再造一套状态图，而是让 Runtime 能识别这个提交点，并用持久化事实完成剩余的无副作用模型总结。

本 change 同时引入结果验收。模型候选正文只是待验收输出；`AcceptanceResult` 才说明系统为何接受或拒绝。天气场景首期使用确定性证据检查，不使用另一个模型充当 Judge。

## Goals / Non-Goals

**Goals:**

- 进程重启后恢复 completed 只读 ToolResult 到最终回答之间的中断 Run。
- 恢复不得再次执行 Connector，并继续受原绝对截止时间约束。
- 天气回答只有绑定持久化地点、数据时间、来源和结果事实后才能完成与交付。
- 用版本化小场景稳定复现崩溃窗口和验收拒绝，并让同一资产分别产生确定性链路证据与真实模型质量证据。

**Non-Goals:**

- 不支持 Token 级续传、模型内部推理恢复或原字节级回答重建。
- 不恢复图片生成、写工具、运行中工具或结果状态未知的外部副作用。
- 不实现 Operation 通用日志、lease、fencing、持久 timer、补偿、人工审批或多实例调度。
- 不用脚本化模型通过率代表真实模型工具选择、回答准确率或生产可用性。
- 不新增 Runtime Client/Server、通用 Operation Engine、独立场景服务或可发布 npm 包。

## Decisions

### 1. 复用 Run 与 ToolCall 作为首期最小执行日志

Run 保存业务身份、操作、模型、绝对截止时间和 ChainTrace ID；ToolCall 保存输入、执行状态和 ToolResult。首期不新增通用 Operation 表。只有 `Run=running`、全部 ToolCall 均为已完成只读调用、至少一个 completed ToolResult、无助手消息且未超过原截止时间时，恢复器才进入最终总结。

其他遗留 Run 进入 `failed`，并保存稳定 `run_recovery_unavailable` 或 `run_recovery_deadline_exceeded` 错误。宁可明确暴露不能恢复，也不猜测未知副作用是否执行。

### 2. 恢复从持久化事实重新规划上下文

恢复器根据原用户消息、消息引用和当前会话事实重新运行 Context Planner，再把 completed ToolResult 构造成 AI SDK 结构化 `tool-call` / `tool-result` 消息。恢复调用不携带 ToolSet、`toolsContext` 或强制工具路由，使用原模型别名、原业务 ID 和原绝对截止时间。

恢复的是“从最近稳定提交点继续”，不是恢复模型隐藏状态。最终文本可能与中断前尚未提交的候选不同，但外部 Connector 不会重复执行。

### 3. AcceptanceResult 是 Run 完成事务的一部分

`AcceptanceResult` 与 Run 一对一，包含策略、版本、`accepted/rejected` 状态、原因码、证据摘要和时间。验收通过时，它与助手消息和 `run.completed` 在同一 SQLite 事务提交；验收拒绝时，它与 `run.failed` 在同一事务提交。

天气策略首期检查：存在匹配的 `weather.v1` ToolResult；正文包含地点、数据时间、来源，以及温度、天气现象、降水、湿度或风速中的至少一个真实结果值。失败 ToolResult 则要求正文明确说明查询未完成，不得伪装为实时结果。

### 4. 需要验收的流式正文先暂存后放行

普通对话继续实时透传。命中 `get_weather` 确定性路由时，Runtime 暂存模型文本增量；候选正文通过验收后，先把 AcceptanceResult、助手消息和 `run.completed` 原子提交，再按原增量顺序向当前渠道放行。验收拒绝时正文不进入渠道，也不写助手消息。

终态提交后的渠道回调属于 Delivery，不再属于模型执行事务。当前连接关闭或回调失败时，Runtime 只记录投递阶段失败，不得把已完成 Run 改写或误报为执行失败；渠道使用原 `requestId` 幂等重放或读取 `latestRun` 获取同一结果。

### 5. 版本化 Scenario Runner 只驱动，不拥有业务规则

Runner 负责创建临时 SQLite、启动故障进程、重启 Runtime、采集 Run/ToolResult/AcceptanceResult/事件并调用场景验收。每个场景分别保存 `case.json`、`deterministic-model.mjs`、`acceptance.mjs` 和 `README.md`，由 `runtime-scenario.v1` 校验版本、支持模式、Prompt、Run、故障和工具 fixture。脚本模型根据模型当前可见消息中的 ToolResult 决策，不使用第几轮之类的隐式计数；天气等业务规则只能存在于场景资产和 Acceptance Policy，不能进入通用 Runner。

双模式共用同一份场景输入、ToolResult fixture 和独立验收：

```text
setup（固定模型）
  -> 调用现有 Runtime 与 Tool Registry
  -> completed ToolResult 提交后退出进程

evaluation
  deterministic -> 固定模型完成恢复总结，验证 Runtime/SQLite/判分链路
  real-model    -> 现有 GatewayClient -> AI SDK -> LiteLLM -> 上游模型
```

真实模式只把 `evaluation` 阶段计入模型质量、token 和延迟；`setup` 单独报告。报告用请求数证明 Model Port 确实被调用，用完成响应数承载实际模型与 token，并单独记录失败数；生命周期证据不保存请求或响应正文。真实模式必须显式固定模型别名，且上游超时、鉴权、限流或质量验收失败时直接失败，不允许回退固定模型。`actualModel` 只能来自已完成的 chat completion 响应，不能用请求别名推断。样本量不足 30 时只给 `observation-only` 结论。

首期保持仓库内逻辑模块和 CLI 稳定出口，不立即拆包。其他 AI 项目可复用 `runtime-scenario.v1` 的资产结构与报告语义，并通过装配层接入自己的 Runtime；出现第二个真实消费方和稳定兼容需求后，再评估独立包或服务。

## Risks / Trade-offs

- 天气流式正文会在模型完成并验收后才放行，牺牲少量首字延迟以避免未验收正文泄漏。
- 首期恢复窗口很窄，但语义可证明；扩大到运行中工具或写操作前必须增加业务幂等、回读和未知状态处理。
- 文本证据检查能保证关键来源完整和至少一个事实绑定，不能证明整段自然语言没有其他错误；真实模型质量仍需独立评测。
- 真实模式当前只评估稳定故障点之后的最终回答质量，不代表真实模型已经覆盖前置 Tool Call 选择；这是为了把故障构造延迟与回答质量分开测量。
- 单进程启动扫描不解决多实例竞争；横向扩容前必须重评 lease/fencing 或成熟持久执行引擎。

## Migration Plan

1. 新增可向后迁移的 Run 恢复字段和 AcceptanceResult 表。
2. 在 Runtime 内实现受限启动恢复与天气验收门禁。
3. 在 Demo Server 监听前执行恢复扫描，不阻断不可恢复 Run 的明确失败收口。
4. 增加 accepted 与 rejected 两个最小故障场景，接入确定性全量回归，并用同一 accepted 资产执行真实模型观察。
5. 固化分模式报告、禁止回退和证据口径；行为稳定后吸收到 stable spec。
6. 出现长任务、复杂分支、人工暂停、多实例或写副作用时重新选择执行引擎；出现第二个独立 AI 项目消费方时重评独立发布形态。

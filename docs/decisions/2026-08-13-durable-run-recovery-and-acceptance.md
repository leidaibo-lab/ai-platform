# 首期可恢复执行与独立结果验收

- 状态：接受
- 日期：2026-08-13
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 治理与可观测
- 关联需求：把“状态能保存”推进为“从稳定提交点继续”，把“模型返回完成”推进为“系统根据事实接受完成”
- 关联 OpenSpec：`openspec/changes/add-durable-run-recovery-and-acceptance/specs/ai-platform/spec.md`
- 替代记录：不替代 `2026-07-31-tool-result-summary-recovery.md`；在其单进程恢复之后增加首个进程重启恢复点

## 问题

当前 SQLite 能保存 Run 和 ToolResult，但进程在 ToolResult 提交后、助手消息提交前退出时，Run 会长期停留在 `running`。模型正文即使缺少天气来源或数据时间，也可能被写成 `completed`。成功证据应是：进程重启后不重复 Connector 就能完成剩余总结；不满足事实证据的候选正文被系统拒绝；两条行为都能由固定故障场景重复验证。

## 约束与非目标

### 必须满足

- SQLite 继续是 Conversation、Run、Message、ToolResult 和 AcceptanceResult 的唯一事实源。
- 只从明确、已提交、无副作用的稳定点恢复；未知副作用一律不猜测和重放。
- 恢复继续使用原绝对截止时间、Run 身份、模型别名和业务关联 ID。
- 脚本化模型只验证 Runtime 状态机、故障窗口和判分链路，不代表真实模型质量。
- 同一版本化场景资产必须能分别运行确定性回归和真实模型质量观察，真实失败不得回退脚本模型。

### 本次不解决

- 不支持复杂状态图、跨请求人工暂停、长任务、持久 timer、多实例竞争或补偿。
- 不恢复图片生成、写工具、运行中工具、Token 增量或模型隐藏推理。
- 不提前建设通用 Operation journal；现有 Run 与 ToolCall 足以表达首个稳定点。
- 不新增 Runtime Client/Server、场景服务或公共 npm 包；先形成仓库内稳定协议和装配边界。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| Temporal | 成熟一体化 | Event History、Worker、重试、timer、长任务和补偿 | 跨进程与跨实例恢复语义完整，适合不可重复副作用 | 当前只有一个分钟级只读稳定点，引入服务、Worker 和第二套执行历史成本过高 | [Temporal 官方文档](https://docs.temporal.io/)、`@temporalio/workflow@1.22.0` |
| LangGraph | 成熟一体化 | 状态图、checkpoint、interrupt 和 durable execution | 适合多分支图、人工介入和跨请求继续 | 当前主链是有界 ToolLoopAgent，迁移会引入图状态与平台 Run 双所有权 | [LangGraph Durable Execution](https://docs.langchain.com/oss/javascript/langgraph/durable-execution)、`@langchain/langgraph@1.4.9` |
| AI SDK Workflow Harness | 轻量可组合 | HarnessAgent 的可序列化 workflow、time slice 和语义步骤 | 与 AI SDK 生态接近，适合未来 coding agent 或长回合 Harness | 当前项目没有 HarnessAgent/workflow 依赖，普通天气 Run 不需要 workspace/session 双状态 | [`@ai-sdk/workflow-harness@1.0.70`](https://www.npmjs.com/package/@ai-sdk/workflow-harness) |
| SQLite Run + ToolCall 稳定点适配 | 最小自研 | completed 只读 ToolResult 后的最终总结恢复和领域验收 | 复用现有事实源，恢复条件窄且可证明，不迁移主链 | 平台只可维护这一受限分支，不能自然扩展成工作流引擎 | 现有 `runs`、`tool_calls`、ToolResult 总结恢复与本 change 场景回归 |

## 淘汰条件

- 候选导致 Conversation、Run、ToolResult 或执行历史出现双事实源。
- 恢复可能重复执行图片生成、写操作、未知状态 Connector 或已经交付的未验收正文。
- 为一个 completed 只读 ToolResult 后的总结阶段引入独立服务、Worker 或通用状态图。
- 验收只检查模型返回非空，或由同一个模型自评完成。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| Run 与 ToolCall 足以定位首个稳定恢复点 | ToolResult 提交后强制退出进程，再打开同一 SQLite | `conversation.chat` + `get_weather`，fixture `1.0.0` | 通过；原 Run 完成且只保留一组用户/助手消息 | `scenarios/runtime/weather-restart-accepted/` |
| 恢复不会再次访问 Connector | 恢复进程装配一旦调用就抛错的 Connector，并检查 ToolCall 数 | persisted `weather.v1` | 通过；accepted/rejected 两个场景重启后 Connector 调用均为 0 | Runtime Scenario Runner 报告 |
| 模型候选不能自行决定完成 | 恢复模型返回缺少来源的天气正文 | 固定 ToolResult 与脚本候选 | 通过；Run 以 `result_acceptance_rejected` 失败，候选未落为助手消息 | `scenarios/runtime/weather-restart-rejected/` |
| 终态后的 Delivery 失败不改写执行事实 | 验收终态提交后令文本消费者抛错，再幂等读取原 Run | accepted 天气候选 | 通过；Run 保持 `completed`，无 `run.failed`，Connector 仍只调用一次 | `scripts/test-runtime.mjs` |
| 场景资产可同时承载确定性和真实模型 | setup 固定构造稳定点，evaluation 按模式切换 Model Port | `runtime-scenario.v1`，Prompt `weather-recovery-eval.v1`，`temperature=1` | 确定性 `2/2`；真实 `gpt-5.6` 已发出 1 次 evaluation 请求，但上游连接 120 秒超时，结果 `0/1 observation-only`，无固定模型回退 | `.data/evaluations/runtime-scenarios-*.json` |
| 当前仍不需要工作流引擎 | 核对依赖、状态所有权和恢复窗口 | `ai@7.0.37`，无 LangGraph/Temporal/Harness 依赖 | 通过 | `package.json` 与本记录候选对比 |

## 决策

- 结论：适配
- 选择方案：复用 SQLite Run + ToolCall 作为首期最小执行日志，并增加领域 AcceptanceResult。
- 决策依据：当前只有一个已持久化、无副作用且无需恢复模型隐藏状态的稳定点；其恢复条件可以穷举并由进程级故障测试证明。成熟引擎的价值在更复杂生命周期出现后才超过接入成本。
- 平台拥有：恢复资格、绝对截止时间、事实读取、上下文重建、验收策略、Run 最终事务、事件和外部交付。
- 外部方案负责：AI SDK 继续负责结构化工具消息和模型生成；LiteLLM 继续负责模型访问和路由；Open-Meteo 继续只负责天气数据。
- 明确不实现：通用 workflow、Operation journal、任务 Worker、lease、fencing、timer、补偿和模型 Judge。
- 复用形态：先固化 `runtime-scenario.v1`、场景目录、双模式 Runner、分阶段报告和 CLI；其他 AI 项目通过装配层复用，出现第二个稳定消费方后再评估独立包或服务。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| Temporal | 当前没有跨实例长任务、可靠 timer、写副作用和补偿链 | 出现小时级任务、多 Worker、不可重复写操作或强补偿要求 |
| LangGraph | 当前没有复杂状态图、人工 interrupt 或跨请求分支继续 | 出现动态分支、人工审批、图 checkpoint 或多阶段回退 |
| AI SDK Workflow Harness | 当前不是 coding agent/Harness session，也没有 time-sliced agent turn | 引入 workspace agent、HarnessAgent、长回合或语义步骤暂停恢复 |
| 立即新增通用 Operation journal | 一个 Run 只有一个已知工具稳定点，抽象字段和状态尚无第二个场景证明 | C2 长任务、C6 写操作或批量任务出现两个以上可恢复动作 |

## 实施边界

Runtime 只扫描自身 SQLite 中的 `running` Run。满足条件时，从原用户消息和会话事实重新规划上下文，把 ToolResult 作为结构化工具消息交给无工具模型总结；不满足时明确失败。天气候选通过确定性 Acceptance Policy 后才能交付和完成。普通 C1 保持 `acceptance=null`，表示当前没有系统独立验收，不能被文档写成 A3。

场景 Runner 不替换 Runtime。setup 固定使用脚本模型经现有 Runtime 与 Tool Registry 构造可重复故障点；deterministic evaluation 继续使用脚本模型验证状态链，real-model evaluation 只使用现有 `GatewayClient -> AI SDK -> LiteLLM -> 上游模型` 验证最终回答。报告区分请求数、完成响应数和失败数；只有完成响应可以提供 `actualModel` 与 token。

## 风险与退出路径

- 已知风险：恢复会重新生成最终文本，不能还原崩溃前未提交的模型字节；天气文本校验只能证明关键证据完整和至少一个事实绑定。
- 真实模型观察：当前配置的上游在 LiteLLM 的 120 秒连接时限内超时；该失败不通过放宽时限或回退固定模型掩盖，待上游恢复后使用相同 fixture、Prompt、参数和别名重跑。
- 锁定点：SQLite Run/ToolCall/AcceptanceResult 数据结构与 AI SDK 结构化工具消息。
- 退出路径：恢复器通过 Store、GatewayClient 和 Acceptance Policy 边界实现；引入成熟引擎时迁移执行编排，Conversation/Run/ToolResult 和验收事实继续由平台拥有。
- 维护责任：AI 应用基础平台维护者负责恢复条件、验收规则、故障 fixture 和重评门禁。

## 验收与完成报告

- 验证证据：`npm test` 为 `101/101`；Runtime、Acceptance 和 Runtime Scenario 聚焦测试分别为 `26/26`、`5/5` 和 `6/6`；accepted/rejected 进程故障场景确定性 `2/2`，两个场景重启后 Connector 调用均为 0。
- 评测与治理：100 轮上下文记忆回归完成 `10/10` checkpoints、`5/5` 指标、准确率 `100%`；Skill 结构校验、Demo 资源预算和 `git diff --check` 均通过。
- 契约验证：`openspec validate add-durable-run-recovery-and-acceptance --strict` 与 `openspec validate --specs --strict` 均通过。
- 真实模型观察：`gpt-5.6` evaluation 已进入现有 Gateway 主链，结果为上游连接超时的 `0/1 observation-only`；样本不足 30，不建立真实质量基线。
- 剩余边界：普通对话没有独立事实验收；图片生成、写操作、多实例与长任务均不具备自动恢复。
- 文档与契约：同步 README、场景链路、OpenSpec change 和决策索引。
- 重评条件：出现第二类有副作用 Operation、跨请求暂停、复杂分支、多实例调度、可靠 timer、人工审批或补偿；或出现第二个独立 AI 项目稳定消费场景协议，需要独立版本与兼容承诺。

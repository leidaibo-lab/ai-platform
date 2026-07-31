# ToolResult 持久化总结恢复

- 状态：接受
- 日期：2026-07-31
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 连接器与知识层 / 治理与可观测
- 关联需求：工具结果已持久化后，后续模型步骤瞬时失败时避免重复执行 Connector，并恢复最终回答
- 关联 OpenSpec：`openspec/specs/ai-platform/spec.md`
- 替代记录：无；补充 `2026-07-31-ai-sdk-core-v7-alignment.md` 的后续恢复里程碑

## 问题

当前 Runtime 已在 Connector 执行前越过整段生成重试边界，因此工具执行后的模型瞬时错误不会重复调用 Connector；但即使只读 ToolResult 已成功写入 SQLite，Run 仍直接失败，用户需要手动重试并再次查询外部数据。需要在不引入第二套 Runtime、不重放 Connector、不伪造文本工具结果的前提下，利用已有事实恢复最终总结。

成功证据是：首个工具只执行一次并落库；工具后的模型步骤失败时，Runtime 从 SQLite 重新读取 ToolResult，使用 AI SDK 结构化工具消息发起不携带 ToolSet 的恢复调用；恢复成功后原 Run 完成且只保存一条助手消息；恢复失败时 Run 明确失败，并同时保留原调用和恢复调用的韧性证据。

## 约束与非目标

### 必须满足

- SQLite ToolResult 是恢复输入的唯一事实源，不依赖 `ToolLoopAgent` 内存状态。
- 只有原调用因 `retry-boundary-crossed` 停止、尚未交付正文且至少存在一个 completed ToolResult 时才自动恢复。
- 恢复调用不携带 ToolSet、`toolsContext` 或强制工具路由，因此不得再次执行 Connector。
- 原调用与恢复调用共享 Run 截止时间、取消信号、模型别名、业务 Trace 和幂等边界。
- 使用 AI SDK `tool-call` / `tool-result` ModelMessage 续接，不能把 ToolResult 拼成普通 Prompt 文本冒充工具消息。

### 本次不解决

- 不支持跨进程、跨实例或服务重启后的运行中任务恢复。
- 不建设通用 checkpoint、状态图、任务调度、持久 timer、补偿或 workflow engine。
- 不覆盖已交付部分正文后的自动重写，也不扩展到写工具和人工审批。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| LangGraph Durable Execution | 成熟一体化 | 状态图、checkpoint、中断和恢复 | 对复杂分支、人工介入和持久图执行内聚 | 当前只有单次 HTTP Run 内的一个恢复分支，引入第二套图 Runtime 和状态所有权成本过高 | [LangGraph 官方文档](https://docs.langchain.com/oss/javascript/langgraph/overview) |
| Temporal | 成熟一体化 | 跨实例长任务、Event History、重试和补偿 | 适合不可重复副作用、可靠 timer 和强恢复 | 当前是分钟内只读调用，无独立 Worker、长任务或跨实例恢复需求 | [Temporal 官方文档](https://docs.temporal.io/temporal) |
| SQLite ToolResult + AI SDK ModelMessage 续接 | 轻量可组合 | 单次 Run 内从已持久化工具事实恢复模型总结 | 复用现有事实源和 AI SDK 原生消息协议，不重放 Connector，不迁移 Runtime | 平台仍需拥有一个受限恢复分支和组合韧性证据 | [AI SDK Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)、`src/storage/conversation-store.mjs` |
| 文本 Prompt 拼接 ToolResult | 最小自研 | 把持久化 JSON 拼入模型提示后重新总结 | 代码表面最少 | 丢失工具调用与结果的协议关系，易被正文混淆，且重复实现 SDK 已有消息结构 | AI SDK v7 `ModelMessage` / `ToolResultPart` 类型声明 |

## 淘汰条件

- 恢复路径可能再次执行 Connector 或绕过 Runtime、GatewayClient、LiteLLM 主链。
- 引入第二个 Conversation、Run 或 ToolResult 事实源。
- 需要把已交付正文静默覆盖，或无法继续遵守原 Run 截止时间和取消语义。
- 为单个有界恢复分支引入通用工作流状态、Worker 或跨实例协调。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 持久化 ToolResult 可按 AI SDK 原生协议续接 | 首步调用天气工具，第二步返回 503，检查第三次请求体 | `ai@7.0.37`，`get_weather`，OpenAI-compatible fake LiteLLM | 通过；恢复请求包含匹配 ID 的结构化 tool call/result 且不包含 tools | `scripts/test-gateway-client.mjs` |
| 恢复不会重复 Connector | 分别执行恢复成功和恢复失败回归并统计调用次数 | completed `weather.v1` ToolResult | 通过；两条路径 Connector 均只执行一次 | `scripts/test-gateway-client.mjs` |
| 流式恢复保持原交付与单消息事实 | 脚本化 Gateway 在恢复阶段调用原 `onTextDelta` | POST SSE 等价 Runtime delivery 回调 | 通过；增量继续交付，Run 完成且只持久化一条助手消息 | `scripts/test-runtime.mjs` |
| 两段失败证据可以独立审计 | 恢复阶段再次返回 503 | 原调用边界失败 + 恢复调用失败 | 通过；顶层保留原证据，`recovery.execution` 保留恢复证据 | `scripts/test-gateway-client.mjs` |

## 决策

- 结论：适配
- 选择方案：复用现有 SQLite ToolResult 事实源，并通过 AI SDK v7 结构化 ModelMessage 发起一次受限的无工具总结恢复阶段。
- 决策依据：当前问题是单次 Run 内丢失最终总结，不是通用持久工作流；现有 SQLite 已拥有工具事实，AI SDK 已拥有 provider-compatible 工具消息转换，平台只需编排最小恢复条件和证据组合。
- 平台拥有：恢复触发条件、SQLite 事实读取、Run 截止时间与取消、模型别名、组合 resilience、最终消息原子持久化和 Trace 关联。
- 外部方案负责：AI SDK 负责结构化工具消息到 provider 协议的转换和无工具模型生成；LiteLLM 继续负责模型访问和网关治理。
- 明确不实现：不自研工具消息字符串协议、工作流引擎、跨实例任务恢复或写副作用补偿。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| LangGraph | 当前没有状态图、人工暂停、跨步骤 checkpoint 或多分支恢复，迁移会放大状态所有权和运行时边界 | 出现复杂分支图、人工介入或跨请求暂停恢复 |
| Temporal | 单次有界只读 Run 不需要 Service、Worker、Event History 和补偿运维 | 出现跨实例小时级任务、可靠 timer、写副作用和强补偿 |
| 文本 Prompt 拼接 | AI SDK 已提供结构化 ModelMessage；文本拼接会降低协议正确性和审计可信度 | 仅在目标 provider 明确不支持标准工具消息且经协议测试证明无法适配时重评 |

## 实施边界

Runtime 捕获原模型异常后，从 Store 重新查询当前 Run 的 completed ToolResult。只有原 resilience 的最后一次失败以 `retry-boundary-crossed` 停止、`outputStarted=false` 且结果非空时，才构造结构化 assistant tool-call 与 tool result 消息。恢复调用沿用原 `ResilienceContext` 的绝对截止时间和取消信号，但不传 ToolSet；恢复成功将原 resilience 保留在顶层，并在 `recovery.execution` 保存恢复阶段证据，随后通过既有 `completeRun` 原子写入唯一助手消息。恢复失败使用同一组合结构后进入既有 `failRun`。

## 风险与退出路径

- 已知风险：当前 tool_calls 表没有保存完整 Agent step transcript；恢复消息按工具开始顺序重建调用/结果对，适合当前只读事实总结，不宣称精确恢复模型内部推理。
- 锁定点：AI SDK v7 `ModelMessage`、`ToolCallPart` 和 `ToolResultPart` 结构；升级时由 Gateway 协议测试验证。
- 退出路径：恢复编排只依赖 GatewayClient Port 和 Store API；达到复杂状态图或跨实例触发条件时可迁移编排，不迁移 ToolResult 事实。
- 维护责任：AI 应用基础平台维护者负责恢复条件、SDK 协议回归、韧性证据和稳定契约。

## 验收与完成报告

- 验证证据：Gateway 21/21、Runtime 22/22、全量 `npm test` 78/78 和 OpenSpec strict 1/1 通过；成功恢复、恢复耗尽、流式恢复和已输出后禁止恢复均有确定性回归。
- 剩余边界：真实模型天气 smoke test、跨进程恢复、写工具审批与补偿仍未完成。
- 文档与契约：同步 OpenSpec、`docs/ai-sdk-core-alignment.md`、场景链路和 README。
- 重评条件：同一 Run 出现复杂多工具分支；需要跨实例或服务重启恢复；进入写工具、人工确认或可靠补偿场景；AI SDK 工具消息协议发生不兼容升级。

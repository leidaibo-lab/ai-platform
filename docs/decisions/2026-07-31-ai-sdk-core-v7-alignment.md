# AI SDK Core v7 调用边界对齐

- 状态：接受
- 日期：2026-07-31
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 模型网关 / 连接器与知识层 / 治理与可观测
- 关联需求：系统核对 AI SDK Core 能力，并修正当前工具循环、结构化输出和 v7 结果字段的使用边界
- 关联 OpenSpec：`openspec/specs/ai-platform/spec.md`
- 关联记录：修正并细化 `2026-07-30-v1-read-only-tool-loop-and-weather.md` 中 `ToolLoopAgent` 的复用与调用分流边界
- 后续记录：`2026-07-31-tool-result-summary-recovery.md` 增加工具后模型瞬时故障的 SQLite ToolResult 无工具恢复边界

## 问题

项目已经采用 AI SDK Core，但此前的方案只围绕 `generateText`、`streamText` 和 `ToolLoopAgent` 局部选择，没有系统区分 Core 原语、Agent 抽象、平台事实和未来场景能力。进一步核对发现：AI SDK v7 已通过 `callOptionsSchema`、`prepareCall`、每次调用的取消/超时以及 Runtime/Tool Context 支持动态 Run，没有必要因模型和工具动态变化而放弃可复用 Agent；同时 MemoryDelta 仍需动态结构化输出，结果映射也仍依赖 v7 弃用兼容字段。这些路径需要按 SDK 的真实能力边界重新分流。

成功证据是：现有 Session/Run 和 GatewayClient 外部契约不变；纯文本工具循环复用一个 `ToolLoopAgent` 并按 Run 动态装配；无工具调用和动态结构化任务继续使用 Core 函数；MemoryDelta 由 `Output.object` 解析校验；代码不再依赖弃用结果字段；文档明确当前、延后和不采用的 Core 能力。

## 约束与非目标

### 必须满足

- 所有业务模型请求仍经 Agent Runtime、GatewayClient 和 LiteLLM。
- Runtime 继续拥有 Conversation、Run、Memory、ToolResult、幂等、权限、取消、重试和交付。
- 同一 Run 的模型与工具步骤共享绝对截止时间，平台保持唯一重试预算。
- 当前模型、工具和 Telemetry 参数按 Run 动态装配。
- 保持现有 chat completions 结果契约和 OpenAI-compatible 输入兼容。

### 本次不解决

- 不引入 MCP、RAG、写工具审批、图片生成、音视频或 Realtime。
- 不建设第二套 provider registry、模型路由控制面或通用 Agent 框架。
- 不把真实模型和真实天气 smoke test 写成已验证完成。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 可复用 `ToolLoopAgent` + call options | 成熟一体化 | Agent 配置、工具循环、停止条件、调用级动态设置和上下文 | SDK 原生支持动态模型、工具、instructions、provider options、取消、超时和上下文，不需每个 Run 新建 Agent | `output` 仍是 Agent 定义级设置，不能通过锁定版本 `prepareCall` 动态切换 | [Configuring Call Options](https://ai-sdk.dev/docs/agents/configuring-call-options) |
| Core `generateText` / `streamText` | 轻量可组合 | 普通模型调用、动态结构化输出、原始兼容请求和流 | 直接适配无工具任务和动态 `Output`，不额外引入 Agent 生命周期 | 平台仍需拥有 Run、工具事实和错误映射 | [Generating Text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text) |
| 自研工具循环与结构化解析 | 最小自研 | 手写工具消息、停止条件、JSON 解析和校验 | 表面依赖最少 | 重复实现 SDK 已有能力，并需长期追赶 provider 和协议变化 | [AI SDK Core](https://ai-sdk.dev/docs/ai-sdk-core) |

## 淘汰条件

- 形成绕过 Runtime 或 LiteLLM 的第二业务入口。
- 让 AI SDK 对象成为平台事实源，或破坏现有 Session/Run 契约。
- 同时启用多层自动重试，放大一次 Run 的调用次数。
- 为尚未进入建设的场景预接公共框架或扩大当前安全边界。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 可复用 Agent 支持动态 Run | 注入测试 Agent 验证 `callOptionsSchema` / `prepareCall`，并由真实 `ToolLoopAgent` 对接 fake LiteLLM 完成两步调用 | `ai@7.0.37`，动态模型与 ToolSet，`get_weather`，最多四步 | 通过；Agent 只创建一次，首步强制工具，第二步恢复 `auto`，ToolResult 正确回填 | `scripts/test-gateway-client.mjs` |
| 工具执行上下文无需逐 Run 闭包重建 ToolSet | 静态 ToolSet 使用 `contextSchema` 校验每次调用的 `toolsContext` | `ai@7.0.37`、Zod Standard Schema | 通过；合法 Runtime 包装器可执行，缺失或多余上下文被拒绝 | `scripts/test-weather-tool.mjs` |
| 工具执行后不能重放整段生成尝试 | 首步执行工具并持久化 ToolResult，第二步模型返回 `503` | `onToolExecutionStart`，平台最大三次尝试 | 通过；Connector 只执行一次，原 Agent 只产生两次模型请求；随后由独立无工具恢复阶段继续，不重放整段循环 | `scripts/test-gateway-client.mjs` |
| 动态结构化工具请求保留 Core 路径 | 同时传入 ToolSet 和当前调用的 `outputSchema`，记录最终 SDK 入口 | `ai@7.0.37`、`Output.object` | 通过；未调用 Agent，Core 获得工具、上下文、停止条件和动态输出 | `scripts/test-gateway-client.mjs` |
| `Output.object` 可穿过 LiteLLM 协议并本地校验 | 检查请求 `response_format=json_schema`，分别返回符合与违反 Zod schema 的 JSON | `@ai-sdk/openai-compatible@3.0.14`、`zod@4.4.3` | 通过；SDK 返回已解析 `output`，schema 不匹配只失败一次且不重试 | `scripts/test-gateway-client.mjs` |
| v7 主字段足以保持现有契约 | 同时覆盖非流式与标准事件流结果映射 | `usage`、`stream`、`finalStep.response` | 通过；正文、模型、usage、finish reason 和错误语义保持 | `scripts/test-gateway-client.mjs` |
| provider 不支持结构化输出时可降级 | 首次结构化请求返回 `400`，第二次使用纯 JSON 提示 | MemoryDelta fixture | 通过；非 `400` 错误不降级 | `scripts/test-runtime.mjs` |

## 决策

- 结论：适配
- 选择方案：纯文本工具型对话复用 AI SDK v7 `ToolLoopAgent`，通过 `callOptionsSchema`、`prepareCall`、`prepareStep`、`runtimeContext` 和 `toolsContext` 适配动态 Run；无工具调用、动态 `Output.object` 和原始 `responseFormat` 兼容调用继续使用 `generateText` / `streamText`。
- 决策依据：当前差异在平台 Run、事实与治理边界，不在通用模型工具消息循环；Agent 已原生覆盖动态调用配置和工具循环，Core 函数则更适合一次性调用与不能通过 `prepareCall` 动态切换的输出契约。
- 平台拥有：GatewayClient Port、模型白名单、Run 截止时间、平台重试、Tool Registry、ToolResult、MemoryDelta 语义、错误映射和持久化。
- 外部方案负责：AI SDK 负责消息转换、工具消息编排、停止条件、结构化解析校验和 SDK Telemetry；LiteLLM 负责模型访问与网关治理。
- 明确不实现：不自研通用工具循环、JSON schema 解析器、provider registry、MCP 协议或 Agent 框架。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| 所有模型调用统一改为 `ToolLoopAgent` | 无工具调用没有循环收益；MemoryDelta 等动态 `Output` 不属于锁定版本 `prepareCall` 的可变字段；原始 `responseFormat` 还需保持兼容请求语义 | 出现稳定、版本化且复用收益明确的专用 AgentDefinition |
| 自研多步循环 | AI SDK 已覆盖工具 schema、消息回填、停止条件、流和错误，重复实现没有平台差异化价值 | AI SDK 无法保持稳定 Run、工具事实或安全契约，且其他成熟 Agent Runtime 也不满足 |
| 一次性接入全部 Core API | Embedding、Rerank、MCP、审批和 Realtime 各自依赖尚未完成的场景数据与安全边界 | 对应 C2-C6 场景进入方案决策并满足自身前置条件 |

## 实施边界

GatewayClient 是 AI SDK Adapter。它在自身生命周期内创建一个工具型对话 Agent；Runtime 传入当前 Run 的模型别名、消息、静态 ToolSet、`toolsContext`、首步路由、截止时间、取消信号和安全 Telemetry context，GatewayClient 返回现有 `choices/model/usage/finish_reason` 契约。`prepareCall` 动态选择模型和工具并配置步骤预算，`prepareStep` 只约束首步工具；MemoryDelta 的 `outputSchema` 使用 Core `Output.object` 和 Zod 本地校验，原始 `responseFormat` 只保留兼容用途。天气工具输入和执行上下文同样使用 Zod 校验，执行仍经 Runtime 包装器写 ToolResult 和阶段事件，LiteLLM 不执行工具。GatewayClient 通过 AI SDK `onToolExecutionStart` 在 Connector 执行前标记不可重放边界，后续瞬时模型错误不得触发整段生成尝试重放。

v7 结果统一使用 `usage`、`stream` 和 `finalStep.response`，不再依赖已弃用的 `totalUsage`、`fullStream` 和顶层 `response`。AI SDK 升级时先在 GatewayClient 协议测试中验证这些映射。

## 风险与退出路径

- 已知风险：部分 OpenAI-compatible provider 不支持严格 JSON Schema；当前只在结构化请求返回 `400` 时退回纯 JSON 提示，结果仍经 Runtime 归一化校验。原始 `jsonSchema()` 没有校验回调时只负责 provider schema，因此内部强类型任务统一使用 Zod Standard Schema。工具后总结恢复已经由后续决策限定为单 Run、completed ToolResult 和未交付正文，不提供完整 Agent transcript 或跨进程恢复。
- 锁定点：AI SDK v7 Result、ToolSet、OpenAI-compatible `response_format`、工具消息格式，以及 `ToolLoopAgent.stream()` 将 `onError` 透传给底层 `streamText` 的实现行为。
- 退出路径：GatewayClient 隔离 SDK 类型；若 AI SDK 不再满足契约，可在 Port 内替换实现，不迁移 Conversation、Run、Memory 或 ToolResult 数据。
- 维护责任：AI 应用基础平台维护者负责版本升级、协议回归和能力地图更新。

## 验收与完成报告

- 验证证据：后续 ToolResult 恢复里程碑加入后，Gateway 21/21、Runtime 22/22、工具 6/6、韧性执行器 3/3 定向测试通过；全量 `npm test` 78/78 和 OpenSpec 严格校验通过。
- 剩余边界：真实模型天气 smoke test、跨进程任务恢复、C3 Embedding/Rerank、MCP 与 C6 tool approval 未接入。
- 文档与契约：同步 `docs/ai-sdk-core-alignment.md`、README、架构/场景文档、既有天气决策和稳定 OpenSpec。
- 重评条件：AI SDK 大版本升级；控制面开始发布可复用 AgentDefinition；LiteLLM provider 不再兼容严格结构化输出；进入 C3、C6 或多 Connector 建设。

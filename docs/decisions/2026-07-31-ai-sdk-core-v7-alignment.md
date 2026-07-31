# AI SDK Core v7 调用边界对齐

- 状态：接受
- 日期：2026-07-31
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 模型网关 / 连接器与知识层 / 治理与可观测
- 关联需求：系统核对 AI SDK Core 能力，并修正当前工具循环、结构化输出和 v7 结果字段的使用边界
- 关联 OpenSpec：`openspec/specs/ai-platform/spec.md`
- 替代记录：部分替代 `2026-07-30-v1-read-only-tool-loop-and-weather.md` 中“适配 ToolLoopAgent”的实现选择

## 问题

项目已经采用 AI SDK Core，但此前的方案只围绕 `generateText`、`streamText` 和 `ToolLoopAgent` 局部选择，没有系统区分 Core 原语、Agent 抽象、平台事实和未来场景能力。进一步核对发现：当前每个 Run 都动态选择模型、工具、截止时间和 Trace，临时创建 Agent 不能形成可复用定义；MemoryDelta 同时手写 `response_format` 与 `JSON.parse`；结果映射仍依赖 v7 弃用兼容字段。这些路径可以工作，但没有与锁定版本的主路径合理对齐。

成功证据是：现有 Session/Run 和 GatewayClient 外部契约不变；工具循环使用适合动态 Run 的 Core 多步调用；MemoryDelta 由 `Output.object` 解析校验；代码不再依赖弃用结果字段；文档明确当前、延后和不采用的 Core 能力。

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
| 每个 Run 临时 `ToolLoopAgent` | 成熟一体化 | Agent 配置、工具、停止条件和调用入口 | 抽象完整，适合稳定 Agent 定义跨入口复用 | 当前动态 Run 每次都重新定义 Agent，增加一层抽象但不减少状态装配 | [Building Agents](https://ai-sdk.dev/docs/agents/building-agents) |
| Core `generateText` / `streamText` 多步调用 | 轻量可组合 | 模型调用、ToolSet、`stopWhen`、`prepareStep`、结构化输出和流 | 直接适配现有 GatewayClient，动态参数自然留在一次 Run 内 | 平台仍需拥有 Run、工具事实和错误映射 | [Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) |
| 自研工具循环与结构化解析 | 最小自研 | 手写工具消息、停止条件、JSON 解析和校验 | 表面依赖最少 | 重复实现 SDK 已有能力，并需长期追赶 provider 和协议变化 | [AI SDK Core](https://ai-sdk.dev/docs/ai-sdk-core) |

## 淘汰条件

- 形成绕过 Runtime 或 LiteLLM 的第二业务入口。
- 让 AI SDK 对象成为平台事实源，或破坏现有 Session/Run 契约。
- 同时启用多层自动重试，放大一次 Run 的调用次数。
- 为尚未进入建设的场景预接公共框架或扩大当前安全边界。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| Core 函数可完成真实多步工具调用 | fake LiteLLM 返回首步 tool call 和第二步文本，执行真实 AI SDK ToolSet | `ai@7.0.37`，`get_weather`，最多四步 | 通过；首步强制工具，第二步恢复 `auto`，ToolResult 正确回填 | `scripts/test-gateway-client.mjs` |
| `Output.object` 可穿过 LiteLLM 协议并校验 | 检查请求 `response_format=json_schema`，返回结构化 JSON | `@ai-sdk/openai-compatible@3.0.14` | 通过；SDK 返回已解析 `output`，schema 不匹配会失败 | `scripts/test-gateway-client.mjs` |
| v7 主字段足以保持现有契约 | 同时覆盖非流式与标准事件流结果映射 | `usage`、`stream`、`finalStep.response` | 通过；正文、模型、usage、finish reason 和错误语义保持 | `scripts/test-gateway-client.mjs` |
| provider 不支持结构化输出时可降级 | 首次结构化请求返回 `400`，第二次使用纯 JSON 提示 | MemoryDelta fixture | 通过；非 `400` 错误不降级 | `scripts/test-runtime.mjs` |

## 决策

- 结论：适配
- 选择方案：AI SDK Core v7 的 `generateText` / `streamText` + `tools` + `stopWhen` + `prepareStep`，结构化结果使用 `Output.object`。
- 决策依据：当前差异在平台 Run、事实与治理边界，不在通用模型工具消息循环；Core 函数与动态 Run 参数最内聚，且不引入新的 Runtime 抽象。
- 平台拥有：GatewayClient Port、模型白名单、Run 截止时间、平台重试、Tool Registry、ToolResult、MemoryDelta 语义、错误映射和持久化。
- 外部方案负责：AI SDK 负责消息转换、工具消息编排、停止条件、结构化解析校验和 SDK Telemetry；LiteLLM 负责模型访问与网关治理。
- 明确不实现：不自研通用工具循环、JSON schema 解析器、provider registry、MCP 协议或 Agent 框架。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| 每次 Run 临时 `ToolLoopAgent` | 模型、工具、截止时间、取消和 Trace 均按 Run 动态注入，Agent 定义无法复用 | 控制面发布稳定、版本化 AgentDefinition，并由多个渠道或任务入口复用 |
| 自研多步循环 | AI SDK 已覆盖工具 schema、消息回填、停止条件、流和错误，重复实现没有平台差异化价值 | AI SDK 无法保持稳定 Run、工具事实或安全契约，且其他成熟 Agent Runtime 也不满足 |
| 一次性接入全部 Core API | Embedding、Rerank、MCP、审批和 Realtime 各自依赖尚未完成的场景数据与安全边界 | 对应 C2-C6 场景进入方案决策并满足自身前置条件 |

## 实施边界

GatewayClient 是 AI SDK Adapter。Runtime 传入当前 Run 的模型别名、消息、ToolSet、首步路由、截止时间、取消信号和安全 Telemetry context；GatewayClient 返回现有 `choices/model/usage/finish_reason` 契约。MemoryDelta 的 `outputSchema` 使用 `Output.object`，原始 `responseFormat` 只保留兼容用途。工具执行仍经 Runtime 包装器写 ToolResult 和阶段事件，LiteLLM 不执行工具。

v7 结果统一使用 `usage`、`stream` 和 `finalStep.response`，不再依赖已弃用的 `totalUsage`、`fullStream` 和顶层 `response`。AI SDK 升级时先在 GatewayClient 协议测试中验证这些映射。

## 风险与退出路径

- 已知风险：部分 OpenAI-compatible provider 不支持严格 JSON Schema；当前只在结构化请求返回 `400` 时退回纯 JSON 提示，结果仍经 Runtime 归一化校验。
- 锁定点：AI SDK v7 Result、ToolSet、OpenAI-compatible `response_format` 和工具消息格式。
- 退出路径：GatewayClient 隔离 SDK 类型；若 AI SDK 不再满足契约，可在 Port 内替换实现，不迁移 Conversation、Run、Memory 或 ToolResult 数据。
- 维护责任：AI 应用基础平台维护者负责版本升级、协议回归和能力地图更新。

## 验收与完成报告

- 验证证据：全量确定性测试 71/71 通过；`npm run test:gateway`、`npm run test:runtime`、`npm test` 和 `openspec validate --specs --strict` 均通过。
- 剩余边界：真实模型结构化输出和天气工具 smoke test 尚未执行；C3 Embedding/Rerank、MCP 与 C6 tool approval 未接入。
- 文档与契约：同步 `docs/ai-sdk-core-alignment.md`、README、架构/场景文档、既有天气决策和稳定 OpenSpec。
- 重评条件：AI SDK 大版本升级；控制面开始发布可复用 AgentDefinition；LiteLLM provider 不再兼容严格结构化输出；进入 C3、C6 或多 Connector 建设。

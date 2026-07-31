# AI SDK Core v7 对齐说明

## 基线与目标

当前项目锁定 `ai@7.0.37` 和 `@ai-sdk/openai-compatible@3.0.14`。本说明以 [AI SDK Core](https://ai-sdk.dev/docs/ai-sdk-core) 官方文档和锁定版本的类型声明为依据，回答三个问题：Core 提供了什么、当前项目应该采用什么、哪些能力必须等对应场景出现后再接入。

AI SDK 是 Agent Runtime 下游的模型与工具执行基础库，不是平台的业务入口、会话事实源或模型网关。稳定主链保持：

```text
渠道 Adapter
  -> Agent Runtime
  -> GatewayClient
  -> AI SDK Core + @ai-sdk/openai-compatible
  -> LiteLLM
  -> 上游 OpenAI-compatible API
```

平台继续拥有 Conversation、Run、Memory、Context Manifest、ToolResult、幂等、权限和交付；AI SDK 负责模型消息、结构化输出、工具消息编排和 SDK 遥测；LiteLLM 负责模型访问、路由和网关治理。

## 采用原则

1. 只对齐当前场景需要的 Core 原语，不把“SDK 有这个 API”直接等同于“平台现在要接入”。
2. 优先使用稳定 Core API，停止依赖 v7 已标记弃用的兼容字段。
3. GatewayClient 保持 Runtime Port，不把 AI SDK 的结果对象直接泄漏给上层。
4. Provider 差异收口在 GatewayClient；业务代码不得直接调用 provider 或 LiteLLM。
5. 工具执行、结构化输出和模型调用都共享 Run 的截止时间、重试、取消和审计边界。

## 当前 API 对齐

| Core 能力 | 当前选择 | 项目映射与边界 |
| --- | --- | --- |
| `generateText` | 已采用 | 无工具的普通非流式生成、MemoryDelta 等一次性结构化任务，以及需要动态 `Output` 的特殊工具调用；AI SDK 内建重试固定为 `0` |
| `streamText` | 已采用 | 无工具或原始 `responseFormat` 兼容调用的 POST SSE 文本增量；Runtime 在首个有效增量后禁止透明重试 |
| `ToolLoopAgent` | 已采用 | GatewayClient 生命周期内复用一个工具型对话 Agent；纯文本工具请求通过 `generate()` / `stream()` 执行有界循环 |
| `callOptionsSchema` + `prepareCall` | 已采用 | 按 Run 校验并动态注入模型、ToolSet、步骤上限、温度、输出上限和 Telemetry；当前 instructions 仍来自 Context Planner，provider options 仍受模型策略白名单约束 |
| `Output.object` + Zod Standard Schema | 已采用 | MemoryDelta 同时生成 provider JSON Schema 并在 Runtime 本地解析校验；provider 不兼容时仅对 `400` 保留纯 JSON 提示降级 |
| `tool` + Zod Standard Schema | 已采用 | Tool Registry 把服务端只读 allowlist 适配为带本地输入校验的静态 AI SDK ToolSet，执行仍由 Runtime 包装 |
| `stopWhen` + `stepCountIs` | 已采用 | Agent 通过 `prepareCall` 按 Run 设置最多四个模型步骤；动态 `Output` 特殊路径直接向 Core 函数传入相同停止条件 |
| `prepareStep` | 已采用 | Agent 读取 `runtimeContext`，只在天气任务首步强制 `get_weather`，ToolResult 回填后恢复 `auto` |
| `runtimeContext` + `toolsContext` | 已采用 | 前者携带安全业务 ID 和首步路由信息；后者按工具名携带经 `contextSchema` 校验的 Runtime 执行包装器，不进入模型 Prompt |
| 每次调用 `abortSignal` + `timeout` | 已采用 | Agent 与 Core 路径都复用当前 Run 的取消信号和剩余绝对截止时间，不另建超时或重试预算 |
| `onToolExecutionStart` | 已采用 | Connector 执行前越过整段生成尝试的自动重试边界，避免后续模型故障重复执行工具 |
| `telemetry` | 已采用 | 默认关闭；启用时接入项目的 OpenTelemetry Facade，输入和输出正文不入 Trace |
| `APICallError` | 已采用 | 映射 provider 状态、公开错误和 `Retry-After`，不把原始响应正文交给渠道 |
| ModelMessage 内容 part | 部分采用 | 当前支持文本、图片 URL 和图片 data URL；媒体治理仍属于 C2 后续能力 |

## v7 结果语义

`ai@7.0.37` 仍保留若干兼容字段，但类型声明已经标记弃用。GatewayClient 统一使用下列主路径：

| 结果信息 | 使用字段 | 不再依赖 |
| --- | --- | --- |
| 多步累计 token | `usage` | `totalUsage` |
| 标准全事件流 | `stream` | `fullStream` |
| 最终响应元数据 | `finalStep.response` | 顶层 `response` |
| 最终结束原因 | 顶层 `finishReason`，必要时读取 `finalStep.finishReason` | provider 私有字段 |
| 结构化结果 | `output` | 业务侧重复 `JSON.parse` 作为主路径 |

GatewayClient 再把这些字段映射为现有 chat completions 契约：`choices`、`model`、`usage` 和 `finish_reason`。Runtime 不直接依赖 AI SDK Result 类型，因此后续升级只需在这个 Adapter 内处理。

## 调用分流与 Agent 抽象

GatewayClient 不把所有模型调用强制改成同一种抽象，而是按任务语义分流：

| 调用类型 | AI SDK 入口 | 原因 |
| --- | --- | --- |
| 有工具、最终输出为普通文本 | 复用 `ToolLoopAgent` | SDK 原生拥有工具消息回填、停止条件和步骤循环；`callOptionsSchema` / `prepareCall` 负责每个 Run 的动态模型、工具和调用设置 |
| 无工具的普通文本 | `generateText` / `streamText` | 没有工具循环，不需要额外 Agent 抽象，继续保持最短调用链 |
| MemoryDelta 等动态结构化任务 | `generateText` + `Output.object` | `output` 是 Agent 定义级泛型和构造设置，不在锁定版本 `prepareCall` 的可动态返回字段中 |
| 原始 `responseFormat` 兼容调用 | `generateText` / `streamText` | 需要保留 GatewayClient 既有 LiteLLM/OpenAI-compatible 请求体转换语义 |
| 工具 + 动态 `outputSchema` / `responseFormat` | Core 函数特殊路径 | 同时保留 ToolSet 有界执行与当前调用的动态输出契约，避免为每种 schema 临时创建 Agent |

工具型对话 Agent 在 `createGatewayClient` 时创建一次，不在每个 Run 内临时创建。每次 `generate()` / `stream()` 直接传入 `abortSignal`、`timeout`、`runtimeContext` 和 `toolsContext`；模型、工具、步骤预算、温度、输出上限和 Telemetry 由类型校验后的 call options 经 `prepareCall` 注入。AI SDK 已提供的循环和上下文能力不再由项目重复实现。

官方文档说明 `prepareCall` 可以动态修改 Agent 设置；锁定版本 `ai@7.0.37` 的类型声明进一步限定其返回字段，其中包含模型、工具、instructions、provider options 和 runtime context，但不包含 `output`。因此结构化任务保留 Core 路径是明确的 SDK 能力边界，不是因为动态 Run 无法复用 Agent。

锁定版本还有一个流错误兼容点：`AgentStreamParameters` 没有公开 `onError`，但 `ToolLoopAgent.stream()` 实现会把该选项透传给底层 `streamText`。GatewayClient 集中注入空错误处理器，避免 SDK 默认向 stderr 打印 provider 原始响应；公开错误仍由现有映射返回。真实 HTTP 测试会在升级后验证该透传行为，失效时必须重新评估适配方式。

Runtime 的平台自动重试单位是一次完整生成尝试。在尚未交付文本且尚未开始工具执行时，可按统一预算重试模型瞬时故障；`onToolExecutionStart` 触发后记录 `retryBoundaryCrossed=true`，后续模型步骤失败时保留已持久化 ToolResult，并以 `retry-boundary-crossed` 停止整段循环重放。若此时尚未交付正文且 SQLite 至少存在一个 completed ToolResult，Runtime 会重新读取事实，使用 AI SDK 结构化 `tool-call` / `tool-result` ModelMessage 发起不携带 ToolSet 的总结恢复；成功和失败分别保存两段 resilience，具体边界见 [`ToolResult 持久化总结恢复`](./decisions/2026-07-31-tool-result-summary-recovery.md)。

## 结构化输出边界

当前存在两条有意区分的路径：

- 新的 Runtime 内部强类型任务使用 `outputSchema -> Output.object({ schema: zodSchema })`，由 AI SDK 负责响应格式、JSON 解析和本地 schema 校验。`zod@4.4.3` 与当前 AI SDK 依赖树对齐，并作为项目直接依赖锁定。
- GatewayClient 继续保留 `responseFormat` 原样透传，兼容尚未迁移的 LiteLLM/OpenAI-compatible 调用；新业务不得继续用它复制一套手写解析逻辑。

原始 `jsonSchema(schema)` 默认只向 provider 提供 JSON Schema；没有 `validate` 回调时不提供本地校验。因此 Runtime 内部需要可信结构化结果或工具参数时必须传入 Zod/Standard Schema，不能只根据 provider 声称支持结构化输出就假设结果已经验证。

MemoryDelta 仍由 Runtime 定义数据语义、字段归属、来源约束和 reducer。AI SDK 只负责生成结果的语法与 schema 校验，不成为 Memory 的事实源。

## 完整 Core 能力地图

| 能力组 | 代表 API | 项目结论 | 触发条件 |
| --- | --- | --- | --- |
| 其他结构化输出 | `Output.array`、`Output.choice`、`Output.json` | 按需采用，不预接 | 出现数组流式抽取、有限枚举分类或无固定 schema JSON |
| 可复用 Agent | `ToolLoopAgent` | 工具型对话已采用 | 控制面发布 AgentDefinition 后，再把当前代码级定义升级为版本化控制面定义 |
| 工具审批 | `toolApproval`、`needsApproval` | 延后到 C6 | 首个有副作用工具进入设计，且权限、预览、人工确认、幂等和回读已定义 |
| Tool/Runtime Context | `toolsContext`、`runtimeContext` | 已采用 | 新增身份或权限字段前仍需稳定契约；上下文不得替代平台身份与权限事实 |
| Provider 管理 | Provider Registry、自定义 Provider | 当前不引入 | Runtime 需要直连多种非 LiteLLM provider；当前统一经 LiteLLM，无第二套路由收益 |
| Model Middleware | `wrapLanguageModel` 等 | 当前不引入 | 出现可跨 provider 复用且无法由 GatewayClient、LiteLLM 或 OTel 承担的明确横切需求 |
| 模型设置与 reasoning | settings、provider options、reasoning | 保持 GatewayClient 白名单 | 模型能力目录和版本化 ModelPolicy 能校验差异，不允许渠道透传任意 provider 参数 |
| 生命周期回调 | start/step/model/tool/end callbacks | 采用 `onToolExecutionStart` 标记重试边界，其余部分由 Telemetry 与 Runtime 包装覆盖 | 需要新增稳定审计事实时先判断归属，不能同时写多份事实源 |
| Embedding | `embed`、`embedMany` | C3 再接 | 文档解析、分块、权限过滤、索引版本和评测基线已定义 |
| Rerank | `rerank` | C3 再接 | 已有候选检索集，并能独立评估召回与重排收益 |
| MCP | `@ai-sdk/mcp` | 多 Connector 后 PoC | 出现跨项目工具复用、独立凭据或进程边界；生产优先 Streamable HTTP |
| 图片生成 | `generateImage` | C2 首个开发切片已采用 | 已经 GatewayClient、LiteLLM、单次尝试和本地 ImageAssetStore 跑通 fake 回归与一次 `gpt-image-2` 真实 happy-path；内容审核、成本、真实异常矩阵和尺寸归一化完成前不得宣称生产可用 |
| 语音与转写 | speech/transcription APIs | 不属于当前切片 | 渠道需要音频输入输出，且文件、隐私和时延边界已定义 |
| Realtime | Realtime 能力 | 不属于当前切片 | C5 需要低延迟双向音频或事件会话，不复用当前 POST SSE 硬承载 |
| 测试工具 | Mock model/provider | 视复杂度采用 | 现有依赖注入和 fake LiteLLM 无法覆盖 provider 行为时 |
| DevTools | AI SDK DevTools | 仅本地诊断候选 | 不写入生产主链，不替代 ChainTrace、Run 事实或正式评测 |

## 明确不对齐的做法

- 不让浏览器、业务模块或 Connector 直接调用 AI SDK Provider。
- 不把 Provider Registry 叠加成 LiteLLM 之外的第二套模型路由控制面。
- 不因 SDK 提供 Memory、MCP、审批或工作流能力，就提前宣称 C3、C6 或跨实例任务已经完成。
- 不同时开启 AI SDK、LiteLLM 和平台三层自动重试；当前唯一尝试预算归 Runtime。
- 不把 AI SDK Telemetry、DevTools 或 callback 结果当作 Conversation、Run、Memory 或 ToolResult 事实源。

## 验证入口

```bash
npm run test:gateway
npm run test:runtime
npm test
openspec validate --specs --strict
```

Gateway 测试覆盖真实 AI SDK 请求体、`Output.object` 解析与本地 schema 正反例校验、可复用 `ToolLoopAgent` 的动态 call options、真实两步工具调用、结构化工具请求回退 Core、首步强制路由、v7 结果字段、流错误和平台重试边界，以及工具开始后禁止整段重放、从 SQLite ToolResult 进行无工具恢复和恢复失败保留双段证据的 Runtime 集成回归。Runtime 测试额外覆盖恢复阶段继续通过原文本回调交付且只落一条助手消息；工具测试覆盖天气输入、默认值和 `contextSchema` 正反例校验。图片生成已用 `gpt-image-2` 完成一次真实 happy-path：请求 `1024x1024` 实际返回 `1254x1254` PNG，usage 只有生成张数而无 token/cost，因此 GatewayClient 保留请求尺寸白名单，资产层以实际返回尺寸为权威值。真实上游对话、天气、图片取消/超时/错误、内容安全与成本仍需分别执行并记录，不能由 fake LiteLLM 或单个成功样本替代。

## 官方资料

- [AI SDK Core](https://ai-sdk.dev/docs/ai-sdk-core)
- [Generating Text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)
- [Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [Runtime and Tool Context](https://ai-sdk.dev/docs/ai-sdk-core/runtime-and-tool-context)
- [Error Handling](https://ai-sdk.dev/docs/ai-sdk-core/error-handling)
- [Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)
- [Building Agents](https://ai-sdk.dev/docs/agents/building-agents)
- [Configuring Call Options](https://ai-sdk.dev/docs/agents/configuring-call-options)

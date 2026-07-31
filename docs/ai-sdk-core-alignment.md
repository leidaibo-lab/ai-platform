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
| `generateText` | 已采用 | JSON Run 和记忆提取的非流式模型调用；AI SDK 内建重试固定为 `0` |
| `streamText` | 已采用 | POST SSE 的模型文本增量；Runtime 在首个有效增量后禁止透明重试 |
| `Output.object` + `jsonSchema` | 已采用 | MemoryDelta 使用 schema 驱动请求、解析和校验；provider 不兼容时仅对 `400` 保留纯 JSON 提示降级 |
| `tool` + `jsonSchema` | 已采用 | Tool Registry 把服务端只读 allowlist 适配为 AI SDK ToolSet，执行仍由 Runtime 包装 |
| `stopWhen` + `stepCountIs` | 已采用 | 当前一次 Run 最多四个模型步骤，不自研通用工具消息循环 |
| `prepareStep` | 已采用 | 只在天气任务首步强制 `get_weather`，ToolResult 回填后恢复 `auto` |
| `runtimeContext` | 已采用 | 只携带安全业务 ID、attempt、scenario 和 operation，供 AI SDK Telemetry 关联 |
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

## Core 多步调用与 Agent 抽象

AI SDK 提供两种都合理但用途不同的入口：

- `generateText` / `streamText` 配合 `tools`、`stopWhen`、`prepareStep`：适合每个 Run 动态选择模型、工具、截止时间、Telemetry 和任务路由的当前 GatewayClient。
- `ToolLoopAgent`：适合把稳定的模型、instructions、ToolSet、停止条件和调用选项定义一次，再从多个入口复用同一个 Agent 定义。

当前项目每个 Run 都要按模型别名、只读 allowlist、用户取消信号、剩余截止时间和业务 Trace 动态装配调用参数，因此采用 Core 多步调用。`ToolLoopAgent` 保留为未来“版本化 AgentDefinition 已由控制面发布且需要跨入口复用”时的候选，不在每次请求内临时创建。

## 结构化输出边界

当前存在两条有意区分的路径：

- 新的 Runtime 内部强类型任务使用 `outputSchema -> Output.object({ schema: jsonSchema(...) })`，由 AI SDK 负责响应格式、JSON 解析和 schema 校验。
- GatewayClient 继续保留 `responseFormat` 原样透传，兼容尚未迁移的 LiteLLM/OpenAI-compatible 调用；新业务不得继续用它复制一套手写解析逻辑。

MemoryDelta 仍由 Runtime 定义数据语义、字段归属、来源约束和 reducer。AI SDK 只负责生成结果的语法与 schema 校验，不成为 Memory 的事实源。

## 完整 Core 能力地图

| 能力组 | 代表 API | 项目结论 | 触发条件 |
| --- | --- | --- | --- |
| 其他结构化输出 | `Output.array`、`Output.choice`、`Output.json` | 按需采用，不预接 | 出现数组流式抽取、有限枚举分类或无固定 schema JSON |
| 可复用 Agent | `ToolLoopAgent` | 当前不作为默认入口 | 控制面发布稳定 AgentDefinition，并需要被多个渠道复用 |
| 工具审批 | `toolApproval`、`needsApproval` | 延后到 C6 | 首个有副作用工具进入设计，且权限、预览、人工确认、幂等和回读已定义 |
| Tool/Runtime Context | `toolsContext`、`runtimeContext` | `runtimeContext` 已用，其他按需 | 工具需要共享强类型请求上下文，但不得替代平台身份与权限事实 |
| Provider 管理 | Provider Registry、自定义 Provider | 当前不引入 | Runtime 需要直连多种非 LiteLLM provider；当前统一经 LiteLLM，无第二套路由收益 |
| Model Middleware | `wrapLanguageModel` 等 | 当前不引入 | 出现可跨 provider 复用且无法由 GatewayClient、LiteLLM 或 OTel 承担的明确横切需求 |
| 模型设置与 reasoning | settings、provider options、reasoning | 保持 GatewayClient 白名单 | 模型能力目录和版本化 ModelPolicy 能校验差异，不允许渠道透传任意 provider 参数 |
| 生命周期回调 | start/step/model/tool/end callbacks | 部分由 Telemetry 与 Runtime 包装覆盖 | 需要新增稳定审计事实时先判断归属，不能同时写多份事实源 |
| Embedding | `embed`、`embedMany` | C3 再接 | 文档解析、分块、权限过滤、索引版本和评测基线已定义 |
| Rerank | `rerank` | C3 再接 | 已有候选检索集，并能独立评估召回与重排收益 |
| MCP | `@ai-sdk/mcp` | 多 Connector 后 PoC | 出现跨项目工具复用、独立凭据或进程边界；生产优先 Streamable HTTP |
| 图片生成 | `generateImage` | 不属于当前切片 | C2 出现明确生成场景、资产存储、审核和成本策略 |
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

Gateway 测试覆盖真实 AI SDK 请求体、`Output.object` 解析与 schema 校验、Core 多步工具调用、首步强制路由、v7 结果字段、流错误和平台重试边界。真实上游模型与天气 smoke test 仍需单独执行并记录，不能由 fake LiteLLM 回归替代。

## 官方资料

- [AI SDK Core](https://ai-sdk.dev/docs/ai-sdk-core)
- [Generating Text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)
- [Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [Runtime and Tool Context](https://ai-sdk.dev/docs/ai-sdk-core/runtime-and-tool-context)
- [Error Handling](https://ai-sdk.dev/docs/ai-sdk-core/error-handling)
- [Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)
- [Building Agents](https://ai-sdk.dev/docs/agents/building-agents)

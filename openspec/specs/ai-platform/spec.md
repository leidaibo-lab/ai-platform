# ai-platform Specification

## Purpose

该规范描述 AI 应用基础平台当前 V0.6 集成切片的稳定能力边界：LiteLLM Proxy 在内部模型网关边界提供 OpenAI-compatible 接口，供 Runtime GatewayClient 和模型连通性诊断使用；服务端保存上游密钥，Agent Runtime 持久化会话、原始消息和结构化记忆，Demo Server 提供浏览器交互入口和分层 Runtime API。

## Requirements

### Requirement: OpenAI-compatible proxy

系统 SHALL 通过 LiteLLM Proxy 暴露 OpenAI-compatible 对话、图片生成和图片编辑 API，供 Agent Runtime 与本地模型连通性诊断访问 gateway；上游凭据只存在于模型网关服务端。

#### Scenario: Gateway receives chat completions

- **GIVEN** LiteLLM Proxy 已启动
- **AND** `.env` 提供了 `LITELLM_MASTER_KEY`、`UPSTREAM_API_BASE` 和对话模型使用的 `UPSTREAM_API_KEY1`
- **WHEN** Agent Runtime 或模型连通性测试请求 `POST /v1/chat/completions`
- **AND** 请求使用 `Authorization: Bearer LITELLM_MASTER_KEY`
- **THEN** 系统 SHALL 将请求转发到配置的上游 OpenAI-compatible API
- **AND** 系统 SHALL 返回 OpenAI-compatible 响应

#### Scenario: Gateway receives image generations

- **GIVEN** LiteLLM Proxy 已启动且 `.env` 提供了图片模型使用的 `UPSTREAM_API_KEY2`
- **WHEN** Agent Runtime 经 GatewayClient 请求 `POST /v1/images/generations` 并使用 `LITELLM_MASTER_KEY`
- **THEN** LiteLLM SHALL 使用图片别名对应的上游映射和服务端 key 转发请求
- **AND** Runtime、渠道和浏览器 SHALL NOT 获取 `UPSTREAM_API_KEY2`

#### Scenario: Gateway receives image edits

- **GIVEN** LiteLLM Proxy 已启动且编辑模型别名对应的上游支持 Responses 图片工具
- **WHEN** Agent Runtime 经 GatewayClient 请求 `POST /v1/responses`，携带一张受控输入图片和 `image_generation.action=edit`，并使用 `LITELLM_MASTER_KEY`
- **THEN** LiteLLM SHALL 使用编辑别名对应的上游映射和服务端 key 转发请求
- **AND** Runtime、渠道和浏览器 SHALL NOT 获取真实上游 key 或地址

### Requirement: Model alias routing

系统 SHALL 向 Runtime GatewayClient 和模型连通性诊断提供稳定模型别名，并在模型网关服务端配置中映射到真实上游模型。

#### Scenario: Runtime or diagnostics uses configured chat alias

- **GIVEN** `config.yaml` 中存在服务端 `LITELLM_MODEL` 对应的模型别名
- **WHEN** Runtime GatewayClient 或 `scripts/test-chat.sh` 发送当前 `LITELLM_MODEL`
- **THEN** LiteLLM SHALL 使用 `litellm_params.model` 指定的真实模型调用上游
- **AND** Runtime 和诊断脚本不需要知道真实上游模型名

#### Scenario: Current stable chat alias maps to a supported upstream model

- **GIVEN** `config.yaml` 声明 `model_name: gpt-5.6` 且 `litellm_params.model: openai/gpt-5.6-sol`
- **AND** 服务端配置 `LITELLM_MODEL=gpt-5.6`
- **WHEN** Runtime 使用默认对话别名调用 LiteLLM
- **THEN** LiteLLM SHALL 把稳定平台别名 `gpt-5.6` 路由到上游 `gpt-5.6-sol`
- **AND** 渠道、Run 请求和普通业务客户端 SHALL NOT 依赖或获得真实上游模型 ID

#### Scenario: Runtime uses operation-specific image aliases

- **GIVEN** `config.yaml` 中存在服务端图片生成和编辑默认模型对应的平台别名
- **WHEN** Runtime 执行 `image.generate`
- **THEN** GatewayClient SHALL 使用 `LITELLM_IMAGE_MODEL` 对应的图片生成别名
- **AND** Runtime 执行 `image.edit` 时 SHALL 使用 `LITELLM_IMAGE_EDIT_MODEL` 对应的 Responses 工具模型别名
- **AND** LiteLLM SHALL 使用各别名对应的真实模型映射与服务端 key 调用上游

#### Scenario: Browser selects an operation-compatible model alias

- **GIVEN** LiteLLM `/v1/models` 返回当前服务端 key 可见的模型别名，且 Demo Server 已按能力策略完成分组
- **WHEN** 浏览器为显式 operation 在会话 Sender 中选择一个别名并通过 Run 请求提交 `model`
- **THEN** 渠道 SHALL 只展示当前 operation 对应能力分组中的别名
- **AND** Runtime SHALL 独立校验并使用该别名执行当前 Run 的 token counter 和模型生成
- **AND** GatewayClient SHALL 继续只把模型别名交给 LiteLLM，不得向浏览器返回真实上游模型配置
- **AND** `conversation.chat` 请求未提供 `model` 时 SHALL 回退服务端 `LITELLM_MODEL`
- **AND** 非默认且不在当前网关可见模型集合中的别名 SHALL 被拒绝
- **AND** `image.generate` 和 `image.edit` SHALL 分别使用服务端 `defaultModels` 中对应且网关可见的别名

#### Scenario: Auto operation uses a server-side default alias

- **WHEN** 浏览器提交 `operation=auto`
- **THEN** 浏览器 SHALL NOT 提交模型别名，Runtime SHALL 拒绝携带 `model` 的 auto 请求
- **AND** Runtime SHALL 在解析真实 operation 后使用 `defaultModels` 中对应且网关可见、能力兼容的平台别名
- **AND** 分类模型 SHALL NOT 选择真实上游模型、provider 参数或图片选项

#### Scenario: Runtime rejects a capability-incompatible conversation alias

- **GIVEN** 请求中的模型别名存在于 LiteLLM `/v1/models`
- **WHEN** `conversation.chat` 使用不属于 `chat` 分组的别名，或带图片输入时使用不属于 `vision` 分组的别名
- **THEN** Runtime SHALL 在 GatewayClient 生成调用前返回 `400 model_capability_mismatch`
- **AND** Runtime SHALL NOT 请求不兼容的 Chat Completions 端点
- **AND** Runtime SHALL NOT 静默删除图片或退化为纯文本
- **AND** JSON 与 POST SSE 公开错误 SHALL 使用 `model_capability_mismatch`，且不得包含 provider 原始响应正文或真实上游模型 ID

#### Scenario: Runtime rejects a capability-incompatible image alias

- **GIVEN** 请求中的模型别名存在于 LiteLLM `/v1/models`
- **WHEN** `image.generate` 使用不属于 `imageGeneration` 分组的别名，或 `image.edit` 使用不属于 `imageEditing` 分组的别名
- **THEN** Runtime SHALL 在 GatewayClient 生成调用前返回 `400 model_capability_mismatch`
- **AND** Runtime SHALL NOT 请求不兼容的图片生成或图片编辑端点
- **AND** Runtime SHALL NOT 静默切换为另一种 operation
- **AND** JSON 与 POST SSE 公开错误 SHALL 使用 `model_capability_mismatch`，且不得包含 provider 原始响应正文或真实上游模型 ID

### Requirement: Server-side secret boundary

系统 SHALL 将模型网关访问凭据和上游真实 key 保持在服务端环境变量中，不得暴露给浏览器、渠道或普通业务客户端。

#### Scenario: Browser uses demo

- **GIVEN** 浏览器打开 Demo 页面
- **WHEN** 用户发送文本、图片或文档链接
- **THEN** 浏览器 SHALL 只请求 Demo Server
- **AND** Demo Server 装配的 Agent Runtime SHALL 通过 GatewayClient 使用服务端的 `LITELLM_MASTER_KEY` 调用 LiteLLM
- **AND** 浏览器 SHALL NOT 获取 `LITELLM_MASTER_KEY`
- **AND** 浏览器 SHALL NOT 获取 `UPSTREAM_API_KEY1` 或 `UPSTREAM_API_KEY2`

### Requirement: Model connectivity smoke test

系统 SHALL 提供最小模型连通性 smoke test，用于验证本地 gateway 是否能完成 chat completions 调用；该脚本 SHALL NOT 构成业务 API 或客户端接入契约。

#### Scenario: Operator runs test-chat script

- **GIVEN** 本地 LiteLLM Proxy 已启动
- **AND** shell 环境中存在可用的 `LITELLM_MASTER_KEY` 和 `LITELLM_MODEL`
- **WHEN** 操作者执行 `bash scripts/test-chat.sh`
- **THEN** 脚本 SHALL 请求 `/v1/chat/completions`
- **AND** 请求体 SHALL 使用当前 `LITELLM_MODEL`
- **AND** 脚本 SHALL 只使用 `LITELLM_MASTER_KEY`，不得读取或接触 `UPSTREAM_API_KEY1` 或 `UPSTREAM_API_KEY2`
- **AND** 该调用 SHALL 仅作为 LiteLLM、模型配置和上游连通性的诊断证据

### Requirement: Global business topology boundary

系统 SHALL 将“渠道经过 Agent Runtime 调用模型”视为唯一平台业务主链，并将模型连通性测试链排除在全局能力规划之外。

#### Scenario: Maintainer documents the global platform topology

- **WHEN** 维护者更新全局链路、能力清单、服务蓝图或演进路线
- **THEN** 文档 SHALL 只把渠道经过 Agent Runtime 的调用视为平台业务主链
- **AND** `scripts/test-chat.sh -> LiteLLM -> 上游模型` SHALL NOT 被描述为业务入口、普通客户端接入方式或服务拆分依赖

### Requirement: Gateway status endpoint

Demo Server SHALL 提供状态检查接口，返回 LiteLLM 连接状态、gateway base url、按操作划分的默认模型和模型能力分组。

#### Scenario: Browser checks status

- **GIVEN** Demo Server 已启动
- **WHEN** 浏览器请求 `GET /api/gateway/status`
- **THEN** Demo Server SHALL 尝试请求 LiteLLM `/v1/models`
- **AND** 响应 SHALL 包含 `ok`、`gatewayBaseUrl`、兼容字段 `model` 与 `imageModel`、当前 key 可见的别名数组 `models`、`defaultModels` 和 `modelCapabilities`
- **AND** `defaultModels` SHALL 分别声明 `conversation.chat`、`image.generate` 和 `image.edit` 的服务端默认平台别名
- **AND** `modelCapabilities` SHALL 包含 `chat`、`vision`、`imageGeneration` 和 `imageEditing` 别名数组，每个数组只包含同时网关可见且由服务端策略声明兼容的稳定平台别名
- **AND** `/v1/models` 可见性 SHALL NOT 被解释为模型支持任意输入模态或端点
- **AND** 状态与能力分组 SHALL 只表示目录可达和静态操作兼容策略，不得表述为上游账号健康或真实生成可用

### Requirement: Runtime gateway client

Agent Runtime SHALL 只通过稳定 GatewayClient Port 调用 LiteLLM；GatewayClient SHALL 复用 AI SDK Core 与 `@ai-sdk/openai-compatible` 处理其已覆盖的模型协议，并用受控 Adapter 补齐锁定依赖未覆盖的 Responses 图片编辑协议。

#### Scenario: Runtime calls the model through LiteLLM

- **GIVEN** Runtime 已配置 LiteLLM 地址、模型别名和访问 key
- **WHEN** Runtime 执行模型调用
- **THEN** 对话和图片生成 SHALL 使用 `@ai-sdk/openai-compatible` 请求 `LITELLM_BASE_URL/v1`
- **AND** 图片编辑 SHALL 由 GatewayClient 内部 Responses Adapter 请求同一 `LITELLM_BASE_URL/v1`
- **AND** SHALL 使用当前 Run 选择的模型别名；未选择时继续使用 `LITELLM_MODEL`
- **AND** SHALL 继续使用 `LITELLM_MASTER_KEY`
- **AND** SHALL NOT 读取 `UPSTREAM_API_KEY` 或绕过 LiteLLM
- **AND** SHALL 禁用 SDK 或 Adapter 路径之外的内建自动重试，由平台统一重试执行器拥有唯一模型尝试预算
- **AND** 默认一次模型生成 SHALL 最多尝试三次，包含首次调用和两次自动重试
- **AND** `image.generate` 与 `image.edit` SHALL 固定单次模型尝试，不得因超时、不确定结果或资产写入失败自动重复调用图片模型
- **AND** 所有尝试 SHALL 复用同一个 Run 和绝对截止时间，不得重复持久化用户消息
- **AND** Runtime SHALL 持久化逐尝试结果、错误分类、退避和最终重试判定
- **AND** 无工具的流式 Run SHALL 使用 AI SDK `streamText`，无工具的非流式 Run SHALL 使用 `generateText`
- **AND** 存在工具且没有动态 `outputSchema` 或原始 `responseFormat` 时 SHALL 复用 GatewayClient 生命周期内的 `ToolLoopAgent`
- **AND** GatewayClient SHALL 通过 `callOptionsSchema` 和 `prepareCall` 按 Run 校验并配置模型、工具、步骤预算和安全 Telemetry，通过 `prepareStep` 执行首步确定性工具路由
- **AND** 每次 Agent 调用 SHALL 传入当前 Run 的 `abortSignal`、剩余 `timeout`、`runtimeContext` 和经工具 `contextSchema` 校验的 `toolsContext`
- **AND** 存在动态 `outputSchema` 或原始 `responseFormat` 时 SHALL 保留 `generateText` / `streamText` Core 路径，并在需要工具时传入同一 ToolSet、停止条件和首步路由
- **AND** ToolLoopAgent 和 Core 函数 SHALL 只作为 GatewayClient 内部实现，不得形成绕过 Runtime 的业务入口

#### Scenario: Runtime retries a transient model failure

- **GIVEN** 模型尚未产生首个有效输出
- **WHEN** GatewayClient 遇到瞬时网络错误、408、429、500、502、503 或 504
- **THEN** 平台重试执行器 SHALL 在 Run 绝对截止时间内按指数退避和抖动执行下一次尝试
- **AND** 429 响应存在 `Retry-After` 时 SHALL 优先遵守该等待时间
- **AND** 最终 SHALL 只持久化一条助手消息或一个失败 Run

#### Scenario: Runtime does not retry a permanent model failure

- **WHEN** GatewayClient 遇到参数、鉴权、权限、上下文长度或内容安全等不可重试错误
- **THEN** Runtime SHALL 立即结束模型尝试并持久化失败状态
- **AND** 调用方取消 SHALL NOT 触发自动重试

#### Scenario: Runtime stops retrying after text output starts

- **GIVEN** 流式模型尝试已经产生首个非空文本增量
- **WHEN** 当前模型流随后遇到原本可重试的超时、网络或服务端错误
- **THEN** 平台重试执行器 SHALL 立即终止该 Run，不得静默发起新的模型尝试
- **AND** 韧性证据 SHALL 将 `outputStarted` 记录为 `true`

#### Scenario: Gateway client preserves the existing model contract

- **GIVEN** Runtime 使用 GatewayClient 执行模型调用
- **WHEN** Runtime 发送文本、多条系统消息、图片 URL、图片 data URL 或结构化输出约束
- **THEN** GatewayClient SHALL 将现有消息转换为等价 AI SDK ModelMessage
- **AND** SHALL 将图片 URL 原样转发给 LiteLLM，不得在 Runtime 提前下载
- **AND** SHALL 保留 `max_completion_tokens` 和兼容调用方原始 `response_format` 的请求语义
- **AND** Runtime 内部结构化任务 SHALL 使用 AI SDK `Output.object` 和带本地校验的 Standard Schema 生成、解析与校验结果
- **AND** SHALL 使用 AI SDK v7 的 `usage` 汇总全部模型步骤、通过 `stream` 消费标准事件，并从 `finalStep.response` 读取最终响应元数据
- **AND** SHALL NOT 依赖已弃用的 `totalUsage`、`fullStream` 或顶层 `response`
- **AND** SHALL 将模型正文、实际模型、usage、finish reason 和 HTTP 错误映射回现有 GatewayClient 契约
- **AND** `/utils/token_counter` 不可用时的本地估算回退 SHALL 保持不变

#### Scenario: Runtime extracts a structured MemoryDelta

- **GIVEN** Memory Manager 已选择需要压缩的连续消息区间
- **WHEN** Runtime 请求模型提取 MemoryDelta
- **THEN** GatewayClient SHALL 通过 `Output.object` 和 Zod Standard Schema 请求并返回已解析的结构化结果
- **AND** AI SDK SHALL 在结果进入 MemoryDelta reducer 前执行本地 Standard Schema 校验
- **AND** provider 以 `400` 拒绝结构化输出请求时 Runtime MAY 移除 `outputSchema`，使用纯 JSON 提示执行一次兼容降级
- **AND** 降级结果 SHALL 继续经过现有 MemoryDelta 字段、来源 ID 和状态归一化校验

### Requirement: Runtime conversation lifecycle

Demo Server SHALL 提供由 Agent Runtime 拥有的会话资源，浏览器不得把本地历史或摘要作为会话事实源。

#### Scenario: User creates and resumes conversations

- **GIVEN** Demo Server 已启动
- **WHEN** 浏览器请求 `POST /api/runtime/conversations`
- **THEN** Runtime SHALL 创建持久化会话并返回 `conversationId`
- **WHEN** 浏览器请求 `GET /api/runtime/conversations` 或 `GET /api/runtime/conversations/{conversationId}`
- **THEN** Runtime SHALL 返回会话列表或完整消息、结构化记忆和版本状态
- **AND** 会话详情 SHALL 通过 `lastRun` 保留最近完成结果，并通过 `latestRun` 暴露最近运行中、完成、取消或失败 Run 的状态与韧性证据

#### Scenario: User closes a conversation

- **GIVEN** 会话状态为 `active`
- **WHEN** 浏览器请求 `POST /api/runtime/conversations/{conversationId}/close`
- **THEN** Runtime SHALL 完成最终记忆 checkpoint 并将会话标记为 `closed`
- **AND** 关闭后的会话 SHALL 拒绝新的 Run

#### Scenario: User organizes conversation history

- **GIVEN** 会话由 Runtime 持久化且当前没有活动 Run
- **WHEN** 浏览器通过 `PATCH /api/runtime/conversations/{conversationId}` 提交非空 `title` 或布尔值 `archived`
- **THEN** Runtime SHALL 原子更新会话标题或独立的归档时间并增加会话版本
- **AND** 归档 SHALL NOT 删除 Conversation、Message、Run、Memory 或事件事实
- **AND** 取消归档 SHALL NOT 把 `closed` 会话重新改为 `active`
- **AND** 搜索、时间分组和归档筛选 MAY 由渠道基于服务端会话摘要完成，不得成为第二份会话事实

#### Scenario: Browser preserves a channel-local draft across refresh

- **GIVEN** 用户在当前浏览器标签页中有尚未发送的正文、链接附件、消息引用或模型选择
- **WHEN** 页面刷新或在会话之间切换
- **THEN** 渠道 MAY 在 session 范围恢复草稿
- **AND** 渠道草稿 SHALL NOT 作为 Conversation、Message 或 Run 事实提交给其他客户端
- **AND** 本地图片 data URL SHALL NOT 写入 session 持久化草稿

### Requirement: Conversation run endpoint

Demo Server SHALL 提供 JSON `POST /api/runtime/conversations/{conversationId}/runs` 和 POST SSE `POST /api/runtime/conversations/{conversationId}/runs/stream`，并按请求或解析后的 `operation` 校验模型别名、文本、附件、图片选项和分类型引用。

#### Scenario: User sends mixed content

- **GIVEN** 目标会话存在且状态为 `active`
- **WHEN** `conversation.chat` 请求至少包含非空 `message`、`imageUrls` 或 `documentUrls` 中的一项
- **AND** 请求包含幂等 `requestId` 和 `clientMessageId`
- **THEN** Runtime SHALL 先持久化用户消息，再构造 OpenAI-compatible `messages`
- **AND** 图片 SHALL 使用 `image_url` 多模态格式
- **AND** 文档链接 SHALL 作为文本上下文附加
- **AND** Runtime SHALL 将请求转发到 LiteLLM `/v1/chat/completions`
- **AND** Runtime SHALL 持久化助手消息、Run 状态、usage、上下文清单和模型逐尝试韧性证据

#### Scenario: Browser receives an actionable model failure

- **GIVEN** Runtime 已持久化用户消息并开始模型生成
- **WHEN** 模型调用因鉴权、权限、限流、超时、请求约束、模型不可用或服务故障失败
- **THEN** Runtime SHALL 持久化失败 Run、安全错误摘要和不包含原始响应正文的 resilience 分类
- **AND** POST SSE `error` 终止事件 SHALL 返回安全错误标题、原因、处理建议、公开错误码和状态
- **AND** 浏览器 SHALL 在对应用户消息后展示失败原因与处理建议，不得只显示无分类的“本次生成失败”
- **AND** 浏览器 SHALL NOT 展示 provider 原始错误正文、stack、上游地址或任何模型访问密钥
- **AND** 浏览器 SHALL 继续提供恢复输入和查看运行信息的入口

#### Scenario: User references a conversation message

- **GIVEN** 当前会话中存在一条已持久化的用户或助手消息
- **WHEN** Run 请求包含 `references: [{ "type": "conversation_message", "messageId": "..." }]`
- **THEN** Runtime SHALL 校验引用消息属于当前会话且当前身份有权访问
- **AND** Runtime SHALL 根据 `messageId` 从会话事实源读取引用内容，不得信任渠道重复提交的消息正文
- **AND** Runtime SHALL 在当前用户消息中持久化引用类型和 `messageId`，并在 Context Manifest 中记录引用的入选或排除结果
- **AND** Runtime SHALL 只装箱被直接引用的消息，不得递归展开该消息可能包含的其他引用
- **AND** 被显式引用的 `interrupted` 助手消息 MAY 作为带中断状态的引用进入当前上下文

#### Scenario: Run contains an unsupported reference type for its operation

- **WHEN** Run 引用类型不在当前 operation 的 allowlist，或缺少该类型要求的稳定 ID
- **THEN** Demo Server SHALL 返回 `400` 输入错误
- **AND** Runtime SHALL NOT 把未知引用降级为字符串、通用 `sourceId` 或 Prompt 拼接内容
- **AND** 普通对话 SHALL 只允许 `conversation_message`，`image.edit` SHALL 只允许 `image_asset`
- **AND** `operation=auto` MAY 按智能路由附件矩阵接受一张受控 `image_asset`；解析为对话后 SHALL 继续把该资产作为受控视觉输入，不得信任渠道提交的 URL、MIME、尺寸或二进制
- **AND** 文档片段、网页快照、业务记录、工具结果、事件、操作回读和批量产物等类型 SHALL 在对应场景明确所有权、版本、时效、权限和失败语义后再加入稳定契约

#### Scenario: Browser receives a streamed answer

- **GIVEN** 浏览器通过 `/runs/stream` 提交带幂等标识的当前输入
- **WHEN** Runtime 创建或命中 Run 并调用流式模型生成
- **THEN** Demo Server SHALL 以 SSE 先发送 `run-started`，再发送零到多个工具阶段事件或 `text-delta`，以及一个 `completed`、`cancelled` 或 `error` 终止事件
- **AND** `text-delta` SHALL 只在内存和网络层传递，不得逐 Token 写入 SQLite
- **AND** 成功完成后 Runtime SHALL 在同一事务中只持久化一条完整助手消息和 Run 最终状态
- **AND** 浏览器断线 SHALL NOT 创建回答 checkpoint 或 Token 级续传状态
- **AND** 渠道 SHALL 能通过会话详情中的 `latestRun` 查询最终状态

### Requirement: V1 read-only tool loop

Agent Runtime SHALL 通过 GatewayClient 复用 AI SDK `ToolLoopAgent` 执行纯文本有界只读工具循环，并只在动态结构化输出等特殊调用中使用带 `tools`、`stopWhen` 和 `prepareStep` 的 Core 函数路径；Runtime 继续拥有 Conversation、Run、权限、工具事实、幂等、交付和审计，LiteLLM SHALL 只负责模型访问、路由和转发，不得执行或保存业务工具结果。

#### Scenario: Model requests current weather

- **GIVEN** `get_weather` 已在服务端 Tool Registry 中启用
- **WHEN** 当前输入包含明确地点且属于今天或明天的天气查询
- **THEN** Runtime SHALL 通过服务端 Tool Registry 和 `ToolLoopAgent.prepareStep` 把首步固定路由到 `get_weather`，ToolResult 回填后的后续步骤恢复自动选择
- **AND** Runtime SHALL 在同一 Run 总截止时间内执行固定目标的 Open-Meteo Connector
- **AND** Runtime SHALL 持久化 `toolCallId`、工具名、脱敏输入、状态、结构化结果或安全错误、来源和数据时间
- **AND** Runtime SHALL 将结构化 ToolResult 回填给同一有界生成循环，由模型生成最终回答
- **AND** 实时天气结果 SHALL NOT 自动写入长期结构化记忆
- **AND** 最终回答 SHALL 能说明地点、数据时间和来源，不得把模型已有知识伪装成实时查询结果

#### Scenario: Browser observes a tool stage

- **GIVEN** 流式 Run 已通过 `run-started` 返回稳定 `runId`
- **WHEN** Runtime 开始、完成或失败一个工具调用
- **THEN** 当前 POST SSE SHALL 分别发送 `tool-started`、`tool-completed` 或 `tool-failed`
- **AND** 事件 SHALL 只包含工具调用 ID、工具名、公开标题、状态、来源和数据时间等安全元数据
- **AND** 渠道 SHALL 根据真实服务端事件展示工具阶段，不得自行猜测或伪造工具执行

#### Scenario: Tool execution fails safely

- **GIVEN** 天气地点不存在、工具输入无效、Connector 超时或上游不可用
- **WHEN** 工具无法返回成功结果
- **THEN** Runtime SHALL 将工具调用收口为 `failed` 并保存稳定错误码、公开说明和可重试性
- **AND** Runtime SHALL 将安全失败结果回填给模型以生成可执行说明，不得暴露原始响应正文、调用栈或任意外部 URL
- **AND** 一个工具失败 SHALL NOT 自动改写为模型服务失败

#### Scenario: Tool loop is bounded and replayable

- **GIVEN** 同一 Run 可能产生多步模型与工具交互
- **WHEN** Runtime 执行工具循环
- **THEN** 循环 SHALL 共享 Run 截止时间并最多执行四个模型步骤
- **AND** 只允许 Tool Registry 中启用的只读工具，不得让模型提交任意 URL 或动态代码
- **AND** 相同 `requestId` 的已完成 Run 重放 SHALL 返回已持久化工具事实和回答，不得再次调用 Connector

#### Scenario: Model fails after tool execution starts

- **GIVEN** 模型已在当前 Run 中生成工具调用
- **WHEN** Runtime 开始执行 Connector，但后续模型步骤返回可重试的瞬时错误
- **THEN** Runtime SHALL 在 Connector 执行前越过当前生成尝试的自动重试边界
- **AND** Runtime SHALL NOT 为该错误重新执行整段模型与工具循环
- **AND** 已开始的工具调用 SHALL 保持其已持久化的 ToolResult 状态
- **AND** 如果尚未交付任何正文且 SQLite 中至少存在一个 completed ToolResult，Runtime SHALL 从会话事实源重新读取结果，并发起一个不携带 ToolSet、`toolsContext` 或强制工具路由的总结恢复阶段
- **AND** 恢复消息 SHALL 使用匹配 `toolCallId` 和工具名的 AI SDK 结构化 `tool-call` / `tool-result` ModelMessage，不得通过普通文本 Prompt 冒充工具结果
- **AND** 恢复阶段 SHALL 共享原 Run 的绝对截止时间、取消信号、模型别名、业务 Trace 和幂等边界，且不得再次执行 Connector
- **AND** 恢复成功后原 Run SHALL 进入 `completed`，并且 Runtime SHALL 只持久化一条完整助手消息

#### Scenario: ToolResult summary recovery cannot complete

- **GIVEN** Runtime 已因工具后模型瞬时错误进入无工具总结恢复阶段
- **WHEN** 恢复调用再次失败、被取消或耗尽原 Run 剩余时限
- **THEN** Runtime SHALL NOT 再次执行 Connector
- **AND** 非取消失败 SHALL 使原 Run 进入 `failed`，并在 resilience 中分别保留原生成失败和恢复执行证据
- **AND** 调用方取消 SHALL 继续遵守独立 `cancelled` 状态和部分正文持久化契约
- **AND** 如果原生成已经交付正文，或不存在 completed ToolResult，Runtime SHALL NOT 自动恢复，Run SHALL 按既有失败语义收口

#### Scenario: User explicitly cancels a running generation

- **GIVEN** 渠道已通过 `run-started` 获得当前 `runId`
- **AND** Run 状态为 `running`
- **WHEN** 渠道请求 `POST /api/runtime/conversations/{conversationId}/runs/{runId}/cancel`
- **THEN** Runtime SHALL 校验 Run 属于当前会话且当前身份有权操作
- **AND** Runtime SHALL 取消当前模型调用及尚未开始的自动重试或退避
- **AND** 调用方取消 SHALL NOT 触发新的模型尝试
- **AND** Run SHALL 进入独立的 `cancelled` 终止状态，不得记录为普通 `failed`
- **AND** 如果已经产生非空文本增量，Runtime SHALL 至多持久化一条状态为 `interrupted` 的助手消息，并保留已交付的部分内容
- **AND** 如果尚未产生非空文本增量，Runtime SHALL NOT 创建空助手消息
- **AND** Demo Server SHALL 通过当前流发送 `cancelled` 终止事件，并通过会话事实事件发布最终 Run 和可选中断消息状态

#### Scenario: User explicitly cancels operation routing before a Run exists

- **GIVEN** 渠道已经提交带 `requestId` 的 Run 请求，但尚未收到 `run-started`
- **WHEN** 渠道请求 `POST /api/runtime/conversations/{conversationId}/run-requests/{requestId}/cancel`
- **THEN** Demo Server SHALL 只中止当前进程中同时匹配 `conversationId` 与 `requestId` 的活动执行，并向 Runtime 传播显式取消信号
- **AND** Runtime SHALL 停止排队、结构化分类或后续准备，不得继续调用业务对话或图片模型
- **AND** 分类完成前的取消 SHALL NOT 创建用户消息、Run、图片资产或伪造 `cancelled` Run
- **AND** 当前渠道流 SHALL 以 `cancelled` 终止事件收口，并显式返回 `run=null` 与 `assistantMessage=null`
- **AND** 浏览器断开 Run 流但未调用该端点时 SHALL NOT 触发请求级取消

#### Scenario: Cancellation is repeated or races with completion

- **GIVEN** 目标 Run 已处于 `completed`、`cancelled` 或 `failed` 终止状态
- **WHEN** 渠道重复请求同一取消端点
- **THEN** Runtime SHALL 幂等返回当前终止状态且不得改写消息、Run 或 usage

#### Scenario: Streaming connection closes without an explicit cancellation

- **GIVEN** Run 仍在执行
- **WHEN** 浏览器刷新、网络中断或 SSE 连接关闭，但渠道没有请求 Run 取消端点
- **THEN** Runtime SHALL NOT 将连接关闭解释为用户取消
- **AND** Runtime SHALL 继续按既有断连恢复语义完成或失败，并允许渠道通过 `latestRun` 查询最终状态

#### Scenario: Request is retried

- **GIVEN** 相同 `requestId` 的 Run 已完成
- **WHEN** 渠道重复提交请求
- **THEN** Runtime SHALL 返回已完成结果且不得重复写入消息或重复调用模型

#### Scenario: User retries, regenerates, or continues as a new Run

- **GIVEN** 当前会话存在一个已持久化的来源 Run
- **WHEN** 浏览器创建新的 Run，并同时提交新的 `requestId`、`clientMessageId`、`sourceRunId` 和 `recoveryMode`
- **THEN** `recoveryMode` SHALL 只允许 `retry`、`regenerate` 或 `continue`
- **AND** Runtime SHALL 校验来源 Run 属于当前会话，且 `retry` 对应 failed、`regenerate` 对应 completed、`continue` 对应 cancelled
- **AND** 新 Run SHALL 继续经过普通输入校验、Context Planner、GatewayClient、持久化和流式交付主链
- **AND** Runtime SHALL 在新 Run 中持久化来源关系，不得修改、删除或覆盖来源 Run 及其消息
- **AND** 恢复动作 SHALL NOT 复用来源 Run 的幂等标识

#### Scenario: Two clients submit to one conversation concurrently

- **GIVEN** 两个客户端同时向同一 Runtime 实例的同一会话提交不同 Run
- **WHEN** 两个请求都通过输入校验
- **THEN** Runtime SHALL 按 `conversationId` 串行执行两个 Run
- **AND** 持久化消息 SHALL 保持完整的 `user -> assistant` 轮次顺序，不得交叉写入回答

#### Scenario: Request has no current input

- **WHEN** `message`、`imageUrls`、`documentUrls` 和 `references` 均为空或缺失
- **THEN** Demo Server SHALL 返回 `400` 输入错误

### Requirement: Runtime smart operation routing

系统 SHALL 允许渠道为普通新 Run 提交 `operation=auto`，并由 Agent Runtime 根据当前输入和有界会话 routing snapshot 解析、校验和持久化真实 operation；分类模型不得直接拥有图片副作用、源资产选择、模型选择、Prompt 组装或附件判定权。

#### Scenario: Browser delegates ordinary routing to Runtime

- **WHEN** 用户在 Demo 普通输入区提交正文、附件或消息引用
- **THEN** Demo SHALL NOT 要求用户选择“对话 / 生图 / 图生图”模式或模型别名
- **AND** Demo SHALL 提交 `operation=auto` 且不提交 `model`，由 Runtime 解析真实 operation
- **AND** 只有历史图片“继续编辑”和 `retry / regenerate / continue` 恢复入口 SHALL 提交已经确定的显式 operation

#### Scenario: Runtime builds a bounded routing snapshot

- **GIVEN** 当前 Conversation 存在已提交的 Message、Run 和 `image_asset` 事实
- **WHEN** Runtime 解析一个普通 auto 请求
- **THEN** Runtime SHALL 读取带会话版本的有界 routing snapshot，并把当前规范化输入与快照分开
- **AND** `routing-context.v2` 快照 SHALL 只包含 `committed` 消息，并排除默认不可信的 `interrupted` 助手片段
- **AND** 快照 SHALL 只包含策略允许消息数量与单条正文字符上限内的近期消息投影、关联真实 Run operation、稳定 messageId 和可空活动图片投影
- **AND** 历史正文投影 SHALL 在字符截断前把 HTTP(S) 与 data URL 替换为稳定占位符，且不得改写 SQLite 中的原始 Message 事实
- **AND** 快照 SHALL NOT 包含图片二进制、storageKey、provider 原始正文、受控读取 URL 或预算外完整会话
- **AND** Runtime SHALL NOT 使用异步 Memory Manager 或渠道本地状态决定本轮活动图片和 operation

#### Scenario: Runtime derives the active image from committed facts

- **WHEN** Runtime 构造 routing snapshot 的活动图片投影
- **THEN** Runtime SHALL 按已提交消息顺序从 Message、真实 Run operation 和 `image_asset` 引用推导最近的合格图片
- **AND** 资产 SHALL 属于当前会话、状态可用且未过期；助手图片 SHALL 来自 completed `image.generate` 或 `image.edit` Run，用户图片 SHALL 是该消息已持久化的唯一受控引用
- **AND** 没有图片引用的普通聊天 SHALL NOT 清空此前可推导的活动图片
- **AND** 仅上传但尚未进入消息的图片、远程 URL、多图、过期资产和跨会话资产 SHALL NOT 成为活动图片

#### Scenario: Runtime derives candidates from current facts and active image

- **GIVEN** Runtime 已校验当前输入、附件类型、数量、会话所有权和资产状态
- **WHEN** auto Run 恰好包含一张当前会话可读取的显式 `image_asset` 且没有其他附件
- **THEN** 允许候选 SHALL 仅为 `conversation.chat` 与 `image.edit`
- **AND** 显式当前图片 SHALL 覆盖历史活动图片，模型不得选择另一 assetId
- **WHEN** auto Run 不包含当前附件或引用但存在可用活动图片
- **THEN** 允许候选 SHALL 仅为 `conversation.chat`、`image.generate` 与 `image.edit`
- **WHEN** auto Run 不包含当前附件或引用且不存在可用活动图片
- **THEN** 允许候选 SHALL 仅为 `conversation.chat` 与 `image.generate`
- **WHEN** auto Run 包含任意 `conversation_message` 引用、远程图片 URL、文档链接或多张图片
- **THEN** Runtime SHALL 将真实 operation 固定为 `conversation.chat`，不得执行图片生成或编辑
- **AND** Runtime SHALL NOT 为该受限输入隐式继承历史活动图片

#### Scenario: Runtime classifies against validated context and evidence

- **GIVEN** 当前候选集包含至少两个 operation
- **WHEN** Runtime 解析 auto Run
- **THEN** Runtime SHALL 通过 GatewayClient 使用 AI SDK `Output.object` 请求且只接受 `operation`、`0..1 confidence`、布尔值 `useActiveImage` 和 `relevantMessageIds` 的结构化结果
- **AND** 分类模型 SHALL NOT 返回或选择 assetId、模型、尺寸、provider 参数、完整 Prompt 或历史消息正文
- **AND** Runtime SHALL 验证 operation 属于当前候选，并验证 `relevantMessageIds` 只指向当前快照内、顺序有效且数量受限的真实消息
- **AND** 视觉问题的当前输入已经自包含完整意图时 `relevantMessageIds` MAY 为空；无当前显式图片的 `image.edit` SHALL 至少包含一条通过校验的历史消息
- **AND** 只有候选中的 `image.generate` 或 `image.edit` 且 `confidence >= 0.85` 时，Runtime MAY 解析为对应图片 operation
- **AND** 无当前显式图片的 `image.edit` SHALL 额外要求 `useActiveImage=true`、可用活动图片和至少一条有效历史消息；`image.generate` SHALL NOT 继承活动图片
- **AND** 候选越权、低置信度、结构不合法、非法证据、活动图片失效、非取消分类失败或剩余截止时间不足 SHALL 安全回退为不继承历史图片的 `conversation.chat`
- **AND** 安全回退 SHALL NOT 创建图片资产、调用图片模型或把同一 Run 作为失败图片 Run 收口
- **AND** 调用方在分类完成前中止请求时 Runtime SHALL 停止分类，不得继续发起对话或图片模型调用，也不得创建或伪造 `cancelled` Run

#### Scenario: Visual chat inherits the active image only when supported

- **GIVEN** auto 请求没有当前附件但 routing snapshot 存在活动图片
- **WHEN** 分类结果为 `conversation.chat`、`useActiveImage=true` 且所有已声明证据通过 Runtime 校验
- **THEN** Runtime SHALL 把服务端选择的活动图片作为受控视觉输入交给能力兼容的对话模型
- **AND** 实际图片引用 SHALL 进入当前 Message/Run 事实，刷新与重放不得依赖前端附件缓存
- **WHEN** `useActiveImage=false`、证据无效或当前输入被附件矩阵固定为对话
- **THEN** Runtime SHALL 执行不携带历史活动图片的普通对话

#### Scenario: Runtime assembles an implicit image edit from immutable evidence

- **GIVEN** auto 请求没有当前附件，分类结果合法选择 `image.edit`
- **WHEN** Runtime 准备业务模型输入
- **THEN** Runtime SHALL 自行选择 snapshot 中已校验的活动图片作为唯一源资产
- **AND** Runtime SHALL 始终包含当前输入，并只从校验通过的 `relevantMessageIds` 对应消息按原顺序组装历史编辑要求
- **AND** Runtime SHALL NOT 使用分类模型自由生成的替代编辑 Prompt
- **AND** 图片调用前 SHALL 再次校验源资产所有权、状态、类型和字节

#### Scenario: Runtime persists a sanitized intent decision

- **WHEN** Runtime 完成 auto 解析并准备执行业务分支
- **THEN** Runtime SHALL 在 Run 事实中保存 `conversation.chat`、`image.generate` 或 `image.edit` 的真实 operation，不得把 `auto` 保存为执行 operation
- **AND** Run SHALL 持久化版本化、脱敏的 `intentDecision`，至少记录 schema/router/context strategy 版本、解析与分类 operation、confidence/threshold、决策来源、候选、`useActiveImage`、校验后的 `relevantMessageIds`、context version 和截断标记
- **AND** 实际 assetId SHALL 通过受控 Message/Run 图片引用持久化，不得来自分类模型输出
- **AND** Runtime SHALL NOT 在 Message、Run JSON、普通日志、Trace 或 intentDecision 中持久化 provider 原始分类文本、隐藏推理、图片内容或完整历史正文
- **AND** 后续模型能力校验、默认别名选择、结果类型、错误语义和重放 SHALL 以真实 operation 为准
- **AND** ExecutionPolicy SHALL 在解析完成后评估真实 operation，不得把入口 `auto` 作为可执行或可持久化操作

#### Scenario: Routing snapshot changes before Run creation

- **GIVEN** Runtime 已基于一个 routing snapshot 完成分类
- **WHEN** Run 创建前当前会话版本已变化
- **THEN** Runtime SHALL NOT 使用过期证据或源资产执行图片 operation
- **AND** Runtime MAY 在有界次数内重新读取和分类；持续冲突 SHALL 返回稳定 `routing_context_changed`

#### Scenario: Auto routing selects a server-side default model

- **WHEN** 渠道提交 `operation=auto`
- **THEN** 渠道 SHALL NOT 提交 `model`，Runtime SHALL 拒绝携带浏览器模型别名的 auto 请求
- **AND** Runtime SHALL 根据真实 operation 使用服务端 `defaultModels` 中对应且当前网关可见、能力兼容的平台别名
- **AND** 分类模型和浏览器 SHALL NOT 选择真实上游模型、provider 参数或图片选项

#### Scenario: Explicit continuation bypasses classification

- **GIVEN** 用户从历史图片显式选择“继续编辑”，或通过 `retry`、`regenerate`、`continue` 从一个既有 Run 发起恢复
- **WHEN** Runtime 创建具有新幂等标识的 Run
- **THEN** 历史图片继续编辑 SHALL 使用显式 `image.edit` 和选定的唯一源资产
- **AND** 恢复 Run SHALL 继承来源 Run 已持久化的真实 operation
- **AND** Runtime SHALL NOT 再次执行意图分类，也不得允许渠道把恢复 operation 改成其他值

#### Scenario: Completed auto request is replayed

- **WHEN** 渠道使用相同 requestId 重放一个已经解析或完成的 auto 请求
- **THEN** Runtime SHALL 返回或继续既有 Run 及其已持久化真实 operation、图片引用和 intentDecision
- **AND** Runtime SHALL NOT 重新分类、切换 operation、重复调用图片模型或创建重复资产

#### Scenario: Routing evaluation separates deterministic and real-model evidence

- **WHEN** 平台验收会话上下文感知的 operation 路由
- **THEN** 确定性模式 SHALL 使用 fixture 驱动分类器和 fake 图片模型验证 snapshot、证据、源资产引用与实际字节、视觉输入、编辑 Prompt 历史、持久化、幂等与零错误图片副作用
- **AND** 真实模型模式 SHALL 固定模型别名、实际模型、Prompt/schema、采样参数和 fixture 版本，只替换分类器并继续使用 fake 图片模型
- **AND** Runner SHALL 根据业务 Gateway 的实际调用参数和失败调用计数判定源图、视觉输入、Prompt 与图片副作用，不得只根据最终持久化引用或产物推断
- **AND** 报告 SHALL 分开给出 operation、错误图片副作用、源资产引用/字节、视觉输入、编辑 Prompt 历史、活动图片包含、证据、token、平均延迟和 P95
- **AND** 通过动态 schema 校验的真实分类样本少于 30 时 SHALL 标记 `observation-only`，不得把未调用分类器的轮次、确定性通过率或小样本百分比表述为真实模型发布准确率

### Requirement: Controlled image upload for C2 editing

Demo Server SHALL 提供会话范围的受控图片上传入口，供 C2 图片编辑建立稳定源资产；上传入口不得成为模型调用或绕过 Runtime 的业务入口。

#### Scenario: Browser uploads a valid source image

- **GIVEN** 目标 Conversation 存在且状态为 `active`
- **WHEN** 浏览器向 `POST /api/runtime/conversations/{conversationId}/image-assets` 提交一张不超过 5 MiB 的 PNG、JPEG 或 WebP 本地图片
- **THEN** Runtime SHALL 校验真实图片类型与声明 MIME 一致，并校验字节和尺寸限制
- **AND** Runtime SHALL 先原子写入 ImageAssetStore，再登记 `source=uploaded` 且无创建 Run 的 SQLite 元数据
- **AND** 响应 SHALL 返回稳定 assetId、版本、MIME、尺寸、哈希、状态和受控读取地址，不得返回 storageKey 或物理路径
- **AND** 上传本身 SHALL NOT 创建 Run 或调用图片模型

#### Scenario: Source image upload fails

- **WHEN** 上传超过限制、声明类型与真实内容不符、图片头或尺寸无效、会话不存在/已关闭或资产存储/元数据登记失败
- **THEN** 系统 SHALL 返回稳定错误并清理未成为可用事实的临时二进制
- **AND** 系统 SHALL NOT 创建 Run 或调用图片模型

#### Scenario: Caller reads an image asset

- **WHEN** 调用方请求 `GET /api/runtime/conversations/{conversationId}/image-assets/{assetId}/content`
- **THEN** Runtime SHALL 校验资产属于当前会话、状态可用且未过期后返回受控 MIME 的图片内容
- **AND** 不存在、过期或跨会话资产 SHALL 使用不泄漏来源会话的缺失错误
- **AND** 响应 SHALL NOT 暴露 storageKey 或物理路径

### Requirement: C2 image generation and editing operations

系统 SHALL 在现有 Conversation Run 和图片资产边界内提供显式 `image.generate` 与 `image.edit`，并让所有图片模型请求统一经过 Agent Runtime、GatewayClient 与 LiteLLM。

#### Scenario: Channel starts an image generation run

- **WHEN** 渠道向 active Conversation 提交 `operation=image.generate`、非空提示词和平台允许的 `imageOptions.size`
- **THEN** Runtime SHALL 拒绝图片 URL、文档和任何引用，只把纯文本提示词与白名单尺寸交给 GatewayClient
- **AND** GatewayClient SHALL 使用 AI SDK `generateImage` 经 LiteLLM `/images/generations` 调用服务端图片模型别名
- **AND** 浏览器 SHALL NOT 提交 provider 专属参数、真实模型名或模型访问密钥

#### Scenario: Channel starts an image editing run

- **WHEN** 渠道向 active Conversation 提交 `operation=image.edit`、非空编辑指令、恰好一条当前会话可访问的 `image_asset` 引用和平台允许的 `imageOptions.size`
- **THEN** Runtime SHALL 根据 assetId 从会话事实源解析资产和内部 storageKey，不得信任渠道提交的 MIME、尺寸、URL 或二进制
- **AND** Runtime SHALL 读取并重新校验源资产字节，再调用 GatewayClient 的图片编辑能力
- **AND** GatewayClient SHALL 把已校验源图转换为请求局部 `input_image` data URL，经 LiteLLM `/v1/responses` 调用 `image_generation` 工具并强制 `action=edit`
- **AND** GatewayClient SHALL NOT 把 Responses 文本输出、缺失图片调用或多个图片调用静默当作编辑成功
- **AND** 浏览器 SHALL NOT 在 Run JSON 中提交图片二进制、provider 参数、真实模型名或模型访问密钥

#### Scenario: Image edit input is invalid

- **WHEN** `image.edit` 缺少非空指令、未恰好提供一张源资产、携带文档/临时图片 URL、引用跨会话资产或提交未知图片选项
- **THEN** Runtime SHALL 在图片模型调用前返回稳定输入或资产错误
- **AND** Runtime SHALL NOT 静默降级为文生图、普通图片理解或远程 URL 导入
- **AND** 当前版本 SHALL NOT 接受遮罩、局部重绘、多图融合或任意 provider 参数透传

#### Scenario: Image operation completes successfully

- **WHEN** 图片模型返回满足平台格式、字节和尺寸策略的单张结果
- **THEN** Runtime SHALL 先写入 ImageAssetStore，再在同一 SQLite 事务中登记资产、助手 Message 引用和 completed Run
- **AND** `image.generate` 结果 SHALL 标记 `source=generated`，`image.edit` 结果 SHALL 标记 `source=edited`
- **AND** 图片编辑 SHALL 创建新的资产，不得覆盖源资产二进制或元数据
- **AND** JSON 结果、助手 Message 和 POST SSE `artifact-created` SHALL 交付稳定 `image_asset` 引用，SSE 继续使用 `completed` 事件收口

#### Scenario: User continues editing the latest image version

- **GIVEN** 一次 `image.edit` 已完成并产生新的 `source=edited` 图片资产
- **WHEN** 渠道把该输出资产作为下一次 `image.edit` 的唯一 `image_asset` 引用并提交新的文字指令
- **THEN** Runtime SHALL 创建具有新 requestId 和 clientMessageId 的普通业务 Run，不得把它标记为 retry、regenerate 或 continue 恢复 Run
- **AND** 第二轮 SHALL 读取上一轮输出资产作为源图，生成新的不可变资产；更早版本 SHALL 保持可读且不被覆盖
- **AND** 渠道 SHALL 允许用户从历史生成或编辑结果显式选择“继续编辑”，成功后把最新输出作为下一轮当前源图

#### Scenario: Completed image operation is replayed

- **WHEN** 客户端使用相同 `requestId` 重放已完成的 `image.generate` 或 `image.edit` Run
- **THEN** Runtime SHALL 返回原 Run 与原图片资产
- **AND** Runtime SHALL NOT 再次调用图片模型、创建重复产物或产生重复费用

#### Scenario: Upstream rejects the Responses image editing tool

- **WHEN** LiteLLM 已接收 `image.edit`，但上游以服务端错误拒绝 Responses 图片工具请求
- **THEN** Runtime SHALL 返回稳定 `image_edit_provider_unavailable` 错误和协议/权限配置建议
- **AND** Runtime、渠道、Run、普通日志和 Trace SHALL NOT 暴露 provider 原始正文或上游分类码

#### Scenario: Image operation cannot be completed safely

- **WHEN** 图片模型请求超时、连接中断、被取消、返回无效图片，或图片二进制/元数据无法持久化
- **THEN** Runtime SHALL 使用 Run 的稳定失败或取消语义收口，并清理未成为可引用事实的临时文件
- **AND** Runtime、GatewayClient 内部 SDK/Adapter 与 LiteLLM SHALL NOT 自动重试图片模型，承载图片副作用的模型别名 SHALL 配置 `num_retries: 0`
- **AND** 渠道、普通日志和 Trace SHALL NOT 包含图片二进制、storageKey、provider 原始错误正文或模型访问密钥

### Requirement: Structured conversation memory

Agent Runtime SHALL 从已持久化的原始消息中提取结构化 MemoryDelta，并通过确定性 Reducer 维护目标、约束、偏好、事实、决策、任务和 Episode。

#### Scenario: User corrects an earlier fact

- **GIVEN** 结构化记忆存在一个 active 事实
- **WHEN** 新消息明确纠正该事实
- **THEN** Memory Manager SHALL 将旧事实标记为 `superseded`
- **AND** SHALL 创建带 `sourceMessageIds` 的新 active 事实
- **AND** 原始消息 SHALL 保留且可用于重建记忆

#### Scenario: Concurrent compaction completes

- **GIVEN** 两个压缩任务基于相同 `memoryVersion` 启动
- **WHEN** 第一个任务已提交新版本
- **THEN** 第二个任务的 compare-and-set 更新 SHALL 失败
- **AND** 第二个任务 SHALL 重新读取水位和版本后重算或幂等结束

### Requirement: Context planning and watermarks

Agent Runtime SHALL 按系统规则、当前输入、active 结构化记忆、相关旧 Episode 和最近完整对话的优先级构造上下文，并按 token 高低水位触发压缩。

#### Scenario: Dynamic context reaches high watermark

- **GIVEN** 动态会话 token 达到可用预算的高水位
- **WHEN** Memory Manager 选择待压缩区间
- **THEN** SHALL 从最老的完整对话轮次开始处理
- **AND** SHALL 压缩到动态会话 token 不高于低水位
- **AND** SHALL 原子更新 `summarizedThroughSeq` 和 `memoryVersion`

#### Scenario: Context exceeds the hard budget

- **GIVEN** 当前请求上下文接近硬上限
- **WHEN** Runtime 构造模型消息
- **THEN** SHALL 同步完成必要压缩
- **AND** SHALL 保留系统和安全规则、当前输入、active 关键记忆及预算内最高优先级内容
- **AND** SHALL 返回 Context Manifest 说明入选内容、排除原因和 token 使用情况

#### Scenario: Context contains an interrupted assistant message

- **GIVEN** 会话中存在用户取消生成后持久化的 `interrupted` 助手消息
- **WHEN** Runtime 为后续普通 Run 构造上下文
- **THEN** Context Planner SHALL 默认排除该中断消息，避免把不完整回答当作可信会话事实
- **AND** 当前 Run 通过 `conversation_message` 显式引用该消息时 MAY 将其作为带中断状态的引用装箱

### Requirement: C1 ChainTrace export

系统 SHALL 通过项目拥有的 `ChainTracer` Port 和标准 OTLP/HTTP protobuf 将脱敏 C1 Trace 旁路导出到正式 Phoenix 后端，并保持 Agent Runtime 对具体观测后端无感知。

#### Scenario: ChainTrace is disabled by default

- **GIVEN** `OTEL_ENABLED` 未设置或为 `false`
- **WHEN** Demo Server 启动并执行 JSON 或 SSE Run
- **THEN** 系统 SHALL 使用无副作用的 Null Object `ChainTracer`
- **AND** 系统 SHALL NOT 初始化 OpenTelemetry SDK、Exporter 或 AI SDK Telemetry
- **AND** Session、Run、Message、Memory、幂等、取消和交付语义 SHALL 保持不变

#### Scenario: Runtime exports a sampled C1 trace

- **GIVEN** `OTEL_ENABLED=true`
- **AND** 服务端已配置 OTLP Trace endpoint、认证 header、`service.name` 和 `parentbased_traceidratio` 采样比例
- **WHEN** Runtime 执行一个被采样的 JSON 或 SSE Run
- **THEN** 系统 SHALL 使用 OTLP/HTTP protobuf 向 Phoenix 的 `/v1/traces` 接口导出 Span
- **AND** Runtime SHALL 只依赖 `ChainTracer` Port，不得依赖 Phoenix 私有追踪 SDK 或查询 API
- **AND** 同一模型重试的所有 Span SHALL 归属同一个 OTel `trace_id`
- **AND** 幂等重放 SHALL 创建新的 OTel Trace、复用原业务 Chain ID，且不得再次调用模型
- **AND** Trace SHALL 能通过 `requestId + conversationId + runId` 对应的 `ai.platform.*` 属性精确定位

#### Scenario: Trace export fails

- **GIVEN** C1 Run 已经开始或完成业务处理
- **WHEN** OTLP exporter 超时、认证失败、被拒绝或 Phoenix 不可用
- **THEN** 导出失败 SHALL NOT 改变 Run 的成功、失败、取消、幂等或持久化语义
- **AND** Phoenix SHALL NOT 成为 Conversation、Run、Message 或 Memory 的事实源
- **AND** Runtime SHALL NOT 因 Trace 导出失败重试模型或重复交付回答

#### Scenario: ChainTrace protects business content and credentials

- **GIVEN** Runtime 执行包含文本、图片、文档链接、模型错误或重试的 Run
- **WHEN** 平台生成和导出 C1 Span
- **THEN** AI SDK Telemetry SHALL 设置 `recordInputs=false` 和 `recordOutputs=false`
- **AND** Span SHALL NOT 记录 Prompt、回答、图片 URL、文档 URL、原始错误正文、stack、模型网关 key 或 Phoenix 认证凭据
- **AND** Span MAY 记录安全业务标识、阶段状态、耗时、错误分类、Context Manifest Token 分段和模型 usage 数值

#### Scenario: Maintainer provisions the accepted ChainTrace backend

- **WHEN** 维护者部署正式 C1 ChainTrace 后端
- **THEN** 系统 SHALL 使用 Phoenix 19.10.0 镜像 `arizephoenix/phoenix@sha256:3092f5543a3ddd35db7390cf971027c33be6be1f171274d57f3c8658c2193d67`
- **AND** Phoenix SHALL 使用独立 PostgreSQL 17 持久化，不得与 Runtime SQLite、LiteLLM 或业务数据库共享数据所有权
- **AND** Phoenix SHALL 启用认证、默认保留 30 天并关闭匿名 telemetry
- **AND** Phoenix 和 OTLP 凭据 SHALL 只由服务端配置持有，不得暴露给浏览器、渠道或普通业务客户端
- **AND** 当前单团队权限 SHALL 限于实例级 `admin`、`member` 和 `viewer` 角色
- **AND** 每次升级 SHALL 先完成可校验备份，并在升级后验证旧 Trace、新 Trace 写入和从升级前数据库恢复的回滚路径

# ai-platform Specification

## Purpose

该规范描述 AI 应用基础平台当前 V0.6 集成切片的稳定能力边界：LiteLLM Proxy 在内部模型网关边界提供 OpenAI-compatible 接口，供 Runtime GatewayClient 和模型连通性诊断使用；服务端保存上游密钥，Agent Runtime 持久化会话、原始消息和结构化记忆，Demo Server 提供浏览器交互入口和分层 Runtime API。

## Requirements

### Requirement: OpenAI-compatible proxy

系统 SHALL 通过 LiteLLM Proxy 暴露 OpenAI-compatible API，供 Agent Runtime 和本地模型连通性诊断访问 gateway。

#### Scenario: Gateway receives chat completions

- **GIVEN** LiteLLM Proxy 已启动
- **AND** `.env` 提供了 `LITELLM_MASTER_KEY`、`UPSTREAM_API_BASE` 和 `UPSTREAM_API_KEY`
- **WHEN** Agent Runtime 或模型连通性测试请求 `POST /v1/chat/completions`
- **AND** 请求使用 `Authorization: Bearer LITELLM_MASTER_KEY`
- **THEN** 系统 SHALL 将请求转发到配置的上游 OpenAI-compatible API
- **AND** 系统 SHALL 返回 OpenAI-compatible 响应

### Requirement: Model alias routing

系统 SHALL 向 Runtime GatewayClient 和模型连通性诊断提供稳定模型别名，并在模型网关服务端配置中映射到真实上游模型。

#### Scenario: Runtime or diagnostics uses chat-default

- **GIVEN** `config.yaml` 中存在 `model_name: chat-default`
- **WHEN** Runtime GatewayClient 或 `scripts/test-chat.sh` 发送 `model: chat-default`
- **THEN** LiteLLM SHALL 使用 `litellm_params.model` 指定的真实模型调用上游
- **AND** Runtime 和诊断脚本不需要知道真实上游模型名

### Requirement: Server-side secret boundary

系统 SHALL 将模型网关访问凭据和上游真实 key 保持在服务端环境变量中，不得暴露给浏览器、渠道或普通业务客户端。

#### Scenario: Browser uses demo

- **GIVEN** 浏览器打开 Demo 页面
- **WHEN** 用户发送文本、图片或文档链接
- **THEN** 浏览器 SHALL 只请求 Demo Server
- **AND** Demo Server 装配的 Agent Runtime SHALL 通过 GatewayClient 使用服务端的 `LITELLM_MASTER_KEY` 调用 LiteLLM
- **AND** 浏览器 SHALL NOT 获取 `LITELLM_MASTER_KEY`
- **AND** 浏览器 SHALL NOT 获取 `UPSTREAM_API_KEY`

### Requirement: Model connectivity smoke test

系统 SHALL 提供最小模型连通性 smoke test，用于验证本地 gateway 是否能完成 chat completions 调用；该脚本 SHALL NOT 构成业务 API 或客户端接入契约。

#### Scenario: Operator runs test-chat script

- **GIVEN** 本地 LiteLLM Proxy 已启动
- **AND** shell 环境中存在可用的 `LITELLM_MASTER_KEY`
- **WHEN** 操作者执行 `bash scripts/test-chat.sh`
- **THEN** 脚本 SHALL 请求 `/v1/chat/completions`
- **AND** 请求体 SHALL 使用 `model: chat-default`
- **AND** 脚本 SHALL 只使用 `LITELLM_MASTER_KEY`，不得读取或接触 `UPSTREAM_API_KEY`
- **AND** 该调用 SHALL 仅作为 LiteLLM、模型配置和上游连通性的诊断证据

### Requirement: Global business topology boundary

系统 SHALL 将“渠道经过 Agent Runtime 调用模型”视为唯一平台业务主链，并将模型连通性测试链排除在全局能力规划之外。

#### Scenario: Maintainer documents the global platform topology

- **WHEN** 维护者更新全局链路、能力清单、服务蓝图或演进路线
- **THEN** 文档 SHALL 只把渠道经过 Agent Runtime 的调用视为平台业务主链
- **AND** `scripts/test-chat.sh -> LiteLLM -> 上游模型` SHALL NOT 被描述为业务入口、普通客户端接入方式或服务拆分依赖

### Requirement: Gateway status endpoint

Demo Server SHALL 提供状态检查接口，返回 LiteLLM 连接状态、gateway base url 和模型别名。

#### Scenario: Browser checks status

- **GIVEN** Demo Server 已启动
- **WHEN** 浏览器请求 `GET /api/gateway/status`
- **THEN** Demo Server SHALL 尝试请求 LiteLLM `/v1/models`
- **AND** 响应 SHALL 包含 `ok`、`gatewayBaseUrl` 和 `model`

### Requirement: AI SDK Runtime gateway client

Agent Runtime SHALL 使用 AI SDK Core 和 `@ai-sdk/openai-compatible` 作为唯一模型生成客户端，并通过稳定 GatewayClient Port 调用 LiteLLM。

#### Scenario: Runtime calls the model through LiteLLM

- **GIVEN** Runtime 已配置 LiteLLM 地址、模型别名和访问 key
- **WHEN** Runtime 执行模型调用
- **THEN** 系统 SHALL 使用 `@ai-sdk/openai-compatible` 请求 `LITELLM_BASE_URL/v1`
- **AND** SHALL 继续使用 `LITELLM_MODEL` 模型别名和 `LITELLM_MASTER_KEY`
- **AND** SHALL NOT 读取 `UPSTREAM_API_KEY` 或绕过 LiteLLM
- **AND** SHALL 禁用 AI SDK 内建自动重试，由平台统一重试执行器拥有唯一模型尝试预算
- **AND** 默认一次模型生成 SHALL 最多尝试三次，包含首次调用和两次自动重试
- **AND** 所有尝试 SHALL 复用同一个 Run 和绝对截止时间，不得重复持久化用户消息
- **AND** Runtime SHALL 持久化逐尝试结果、错误分类、退避和最终重试判定
- **AND** 流式 Run SHALL 使用 AI SDK `streamText`，非流式 Run SHALL 保持既有 `generateText` 契约

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
- **AND** SHALL 保留 `max_completion_tokens` 和 `response_format` 请求语义
- **AND** SHALL 将模型正文、实际模型、usage、finish reason 和 HTTP 错误映射回现有 GatewayClient 契约
- **AND** `/utils/token_counter` 不可用时的本地估算回退 SHALL 保持不变

### Requirement: Runtime conversation lifecycle

Demo Server SHALL 提供由 Agent Runtime 拥有的会话资源，浏览器不得把本地历史或摘要作为会话事实源。

#### Scenario: User creates and resumes conversations

- **GIVEN** Demo Server 已启动
- **WHEN** 浏览器请求 `POST /api/runtime/conversations`
- **THEN** Runtime SHALL 创建持久化会话并返回 `conversationId`
- **WHEN** 浏览器请求 `GET /api/runtime/conversations` 或 `GET /api/runtime/conversations/{conversationId}`
- **THEN** Runtime SHALL 返回会话列表或完整消息、结构化记忆和版本状态
- **AND** 会话详情 SHALL 通过 `lastRun` 保留最近完成结果，并通过 `latestRun` 暴露最近运行中、完成或失败 Run 的状态与韧性证据

#### Scenario: User closes a conversation

- **GIVEN** 会话状态为 `active`
- **WHEN** 浏览器请求 `POST /api/runtime/conversations/{conversationId}/close`
- **THEN** Runtime SHALL 完成最终记忆 checkpoint 并将会话标记为 `closed`
- **AND** 关闭后的会话 SHALL 拒绝新的 Run

### Requirement: Conversation run endpoint

Demo Server SHALL 提供 JSON `POST /api/runtime/conversations/{conversationId}/runs` 和 POST SSE `POST /api/runtime/conversations/{conversationId}/runs/stream`，两者均支持文本、图片 URL、图片 data URL 和文档链接。

#### Scenario: User sends mixed content

- **GIVEN** 目标会话存在且状态为 `active`
- **WHEN** 请求至少包含非空 `message`、`imageUrls` 或 `documentUrls` 中的一项
- **AND** 请求包含幂等 `requestId` 和 `clientMessageId`
- **THEN** Runtime SHALL 先持久化用户消息，再构造 OpenAI-compatible `messages`
- **AND** 图片 SHALL 使用 `image_url` 多模态格式
- **AND** 文档链接 SHALL 作为文本上下文附加
- **AND** Runtime SHALL 将请求转发到 LiteLLM `/v1/chat/completions`
- **AND** Runtime SHALL 持久化助手消息、Run 状态、usage、上下文清单和模型逐尝试韧性证据

#### Scenario: Browser receives a streamed answer

- **GIVEN** 浏览器通过 `/runs/stream` 提交带幂等标识的当前输入
- **WHEN** Runtime 创建或命中 Run 并调用流式模型生成
- **THEN** Demo Server SHALL 以 SSE 依次发送 `run-started`、零到多个 `text-delta`，以及一个 `completed` 或 `error` 终止事件
- **AND** `text-delta` SHALL 只在内存和网络层传递，不得逐 Token 写入 SQLite
- **AND** 成功完成后 Runtime SHALL 在同一事务中只持久化一条完整助手消息和 Run 最终状态
- **AND** 浏览器断线 SHALL NOT 创建回答 checkpoint 或 Token 级续传状态
- **AND** 渠道 SHALL 能通过会话详情中的 `latestRun` 查询最终状态

#### Scenario: Request is retried

- **GIVEN** 相同 `requestId` 的 Run 已完成
- **WHEN** 渠道重复提交请求
- **THEN** Runtime SHALL 返回已完成结果且不得重复写入消息或重复调用模型

#### Scenario: Two clients submit to one conversation concurrently

- **GIVEN** 两个客户端同时向同一 Runtime 实例的同一会话提交不同 Run
- **WHEN** 两个请求都通过输入校验
- **THEN** Runtime SHALL 按 `conversationId` 串行执行两个 Run
- **AND** 持久化消息 SHALL 保持完整的 `user -> assistant` 轮次顺序，不得交叉写入回答

#### Scenario: Request has no current input

- **WHEN** `message`、`imageUrls` 和 `documentUrls` 均为空或缺失
- **THEN** Demo Server SHALL 返回 `400` 输入错误

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

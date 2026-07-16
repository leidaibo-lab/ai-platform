# ai-gateway Specification

## Purpose

该规范描述当前轻量 AI Gateway 已落地切片的稳定能力边界：LiteLLM Proxy 对外暴露 OpenAI-compatible 接口，服务端保存上游密钥，Demo Server 提供浏览器交互入口和 Runtime 分层 API。

## Requirements

### Requirement: OpenAI-compatible proxy

系统 SHALL 通过 LiteLLM Proxy 暴露 OpenAI-compatible API，并允许客户端使用 `LITELLM_MASTER_KEY` 访问本地 gateway。

#### Scenario: Client calls chat completions

- **GIVEN** LiteLLM Proxy 已启动
- **AND** `.env` 提供了 `LITELLM_MASTER_KEY`、`UPSTREAM_API_BASE` 和 `UPSTREAM_API_KEY`
- **WHEN** 客户端请求 `POST /v1/chat/completions`
- **AND** 请求使用 `Authorization: Bearer LITELLM_MASTER_KEY`
- **THEN** 系统 SHALL 将请求转发到配置的上游 OpenAI-compatible API
- **AND** 系统 SHALL 返回 OpenAI-compatible 响应

### Requirement: Model alias routing

系统 SHALL 对客户端暴露稳定模型别名，并在服务端配置中映射到真实上游模型。

#### Scenario: Client uses chat-default

- **GIVEN** `config.yaml` 中存在 `model_name: chat-default`
- **WHEN** 客户端发送 `model: chat-default`
- **THEN** LiteLLM SHALL 使用 `litellm_params.model` 指定的真实模型调用上游
- **AND** 客户端不需要知道真实上游模型名

### Requirement: Server-side secret boundary

系统 SHALL 将上游真实 key 保持在服务端环境变量中，不得暴露给浏览器 Demo 或客户端文档示例。

#### Scenario: Browser uses demo

- **GIVEN** 浏览器打开 Demo 页面
- **WHEN** 用户发送文本、图片或文档链接
- **THEN** 浏览器 SHALL 只请求 Demo Server
- **AND** Demo Server SHALL 使用服务端的 `LITELLM_MASTER_KEY` 调用 LiteLLM
- **AND** 浏览器 SHALL NOT 获取 `UPSTREAM_API_KEY`

### Requirement: Local smoke test

系统 SHALL 提供最小 smoke test，用于验证本地 gateway 是否能完成 chat completions 调用。

#### Scenario: Operator runs test-chat script

- **GIVEN** 本地 LiteLLM Proxy 已启动
- **AND** shell 环境中存在可用的 `LITELLM_MASTER_KEY`
- **WHEN** 操作者执行 `bash scripts/test-chat.sh`
- **THEN** 脚本 SHALL 请求 `/v1/chat/completions`
- **AND** 请求体 SHALL 使用 `model: chat-default`

### Requirement: Gateway status endpoint

Demo Server SHALL 提供状态检查接口，返回 LiteLLM 连接状态、gateway base url 和模型别名。

#### Scenario: Browser checks status

- **GIVEN** Demo Server 已启动
- **WHEN** 浏览器请求 `GET /api/gateway/status`
- **THEN** Demo Server SHALL 尝试请求 LiteLLM `/v1/models`
- **AND** 响应 SHALL 包含 `ok`、`gatewayBaseUrl` 和 `model`

### Requirement: Runtime chat endpoint

Demo Server SHALL 提供聊天接口，支持文本、图片 URL、图片 data URL、文档链接和最近上下文。

#### Scenario: User sends mixed content

- **GIVEN** Demo Server 已启动
- **WHEN** 浏览器请求 `POST /api/runtime/chat`
- **AND** 请求包含 `message`、`imageUrls`、`documentUrls`、`history` 或 `summary`
- **THEN** Demo Server SHALL 构造 OpenAI-compatible `messages`
- **AND** 图片 SHALL 使用 `image_url` 多模态格式
- **AND** 文档链接 SHALL 作为文本上下文附加
- **AND** Demo Server SHALL 将请求转发到 LiteLLM `/v1/chat/completions`

### Requirement: Runtime summary endpoint

Demo Server SHALL 提供摘要接口，用于将旧对话压缩成后续请求可复用的中文上下文摘要。

#### Scenario: History exceeds recent window

- **GIVEN** 浏览器已有历史消息
- **WHEN** 浏览器请求 `POST /api/runtime/summaries`
- **THEN** Demo Server SHALL 调用 LiteLLM 生成中文摘要
- **AND** 摘要 SHALL 保留用户目标、关键事实、已做决定、代码或文件名、未完成事项

### Requirement: Context budget guard

Demo Server SHALL 对历史消息和摘要做估算 token 预算控制，优先保留当前消息、摘要和最近历史。

#### Scenario: History is too long

- **GIVEN** `history` 超过当前上下文预算
- **WHEN** Demo Server 构造 `messages`
- **THEN** 系统 SHALL 保留当前消息
- **AND** 系统 SHALL 优先保留摘要和最近历史
- **AND** 系统 SHALL 裁剪超预算的旧消息

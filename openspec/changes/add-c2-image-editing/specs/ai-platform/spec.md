## ADDED Requirements

### Requirement: C2 image editing operation

系统 SHALL 在现有 Conversation Run 和 C2 图片资产边界内提供显式 `image.edit`，并保持源资产不可变、编辑结果可审计和模型调用统一经过 Agent Runtime、GatewayClient 与 LiteLLM。

#### Scenario: Channel starts an image editing run

- **WHEN** 渠道向 active Conversation 提交 `operation=image.edit`、非空编辑指令、一条当前会话可访问的 `image_asset` 引用和平台允许的图片选项
- **THEN** Runtime SHALL 在创建模型请求前校验引用类型、资产所有权、状态、真实媒体元数据和数量限制
- **AND** Runtime SHALL 通过 GatewayClient 与 LiteLLM 调用 `image.edit` 对应的 Responses 工具模型别名
- **AND** 浏览器 SHALL NOT 提交图片二进制到 Run JSON、provider 参数、真实模型名或模型访问密钥

#### Scenario: Image edit input is invalid

- **WHEN** `image.edit` 缺少非空指令、未恰好提供一张源资产、携带文档/临时图片 URL、引用跨会话资产或提交未知图片选项
- **THEN** Runtime SHALL 在图片模型调用前返回稳定输入错误
- **AND** Runtime SHALL NOT 静默降级为文生图或普通图片理解

#### Scenario: Gateway edits an image

- **GIVEN** Runtime 已读取并校验源资产字节
- **WHEN** GatewayClient 执行图片编辑
- **THEN** GatewayClient SHALL 使用受控 Responses Adapter，把源图作为请求局部 `input_image` data URL，并经 `/v1/responses` 调用 `image_generation.action=edit`
- **AND** GatewayClient SHALL 只接受唯一、已完成且包含合法 Base64 结果的 `image_generation_call`
- **AND** GatewayClient SHALL 固定单次尝试并传播 Run 的绝对截止时间和取消信号
- **AND** LiteLLM 编辑模型别名 SHALL 配置 `num_retries: 0`，不得在网关内重复图片副作用

#### Scenario: Image editing completes successfully

- **WHEN** 图片模型返回满足格式与尺寸策略的编辑结果
- **THEN** Runtime SHALL 创建新的 `source=edited` 图片资产，不得覆盖源资产二进制或元数据
- **AND** 用户 Message SHALL 保存源 `image_asset` 引用，助手 Message、Run JSON 和 SSE SHALL 交付新的 `image_asset` 引用

#### Scenario: User continues from an edited image

- **GIVEN** 上一轮 `image.edit` 已创建可用的输出资产
- **WHEN** 用户把该输出资产作为下一轮唯一源图并提交新的文字指令
- **THEN** 渠道 SHALL 创建新的普通 `image.edit` Run，不得复用上一轮 requestId 或设置 recovery 字段
- **AND** Runtime SHALL 以该输出资产字节作为新源图，并创建另一个不可变输出资产

#### Scenario: Completed image editing is replayed

- **WHEN** 客户端使用相同 `requestId` 重放已完成的 `image.edit` Run
- **THEN** Runtime SHALL 返回原 Run 与原编辑资产
- **AND** Runtime SHALL NOT 再次读取模型结果、调用图片模型或产生重复费用

#### Scenario: Image editing follows execution governance and is not restart-replayed

- **GIVEN** `image.edit` 已由显式请求或 `auto` 解析为真实 operation
- **WHEN** Runtime 执行策略评估、取得 RunLease 并提交图片终态
- **THEN** ExecutionPolicy SHALL 评估真实 `image.edit`，不得评估入口 `auto`
- **AND** 图片完成、失败或取消 SHALL 携带当前 fencing token 提交并释放 lease
- **AND** 服务重启扫描到遗留 `image.edit` Run 时 SHALL 明确失败，不得再次调用图片模型或创建新资产

#### Scenario: Upstream rejects the Responses image editing tool

- **WHEN** LiteLLM 已接收 `image.edit`，但上游以服务端错误拒绝 Responses 图片工具请求
- **THEN** Runtime SHALL 返回稳定 `image_edit_provider_unavailable` 错误和协议/权限配置建议
- **AND** Runtime、渠道、Run、普通日志和 Trace SHALL NOT 暴露 provider 原始正文或上游分类码

### Requirement: Controlled image upload for editing

Demo Server SHALL 提供会话范围的受控图片上传入口，供 C2 操作建立稳定源资产；上传入口不得成为模型调用或绕过 Runtime 的业务入口。

#### Scenario: Browser uploads a valid source image

- **WHEN** 浏览器向 `POST /api/runtime/conversations/{conversationId}/image-assets` 提交一张允许 MIME、字节和尺寸范围内的本地图片
- **THEN** Runtime SHALL 校验真实图片类型与声明 MIME 一致，先原子写入 ImageAssetStore，再登记 `source=uploaded` 的 SQLite 元数据
- **AND** 响应 SHALL 返回稳定 assetId、版本、MIME、尺寸、哈希、状态和受控读取地址，不得返回 storageKey 或物理路径

#### Scenario: Source image upload fails

- **WHEN** 上传超过限制、声明类型与真实内容不符、图片无效、会话不存在/已关闭或资产存储/元数据登记失败
- **THEN** 系统 SHALL 返回稳定错误并清理未成为可用事实的临时二进制
- **AND** 系统 SHALL NOT 创建 Run 或调用图片模型

## MODIFIED Requirements

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

#### Scenario: User references an image asset for editing

- **GIVEN** 当前会话中存在一张可用 `image_asset`
- **WHEN** `image.edit` Run 包含 `references: [{ "type": "image_asset", "assetId": "..." }]`
- **THEN** Runtime SHALL 根据 assetId 从会话事实源解析资产和内部存储引用，不得信任渠道提交的 MIME、尺寸、URL 或二进制
- **AND** 当前稳定契约 SHALL 只允许 `image.edit` 使用 `image_asset` 引用；普通对话仍只允许 `conversation_message`

#### Scenario: Run contains an unsupported reference type for its operation

- **WHEN** Run 引用类型不在当前 operation 的 allowlist，或缺少该类型要求的稳定 ID
- **THEN** Demo Server SHALL 返回 `400` 输入错误
- **AND** Runtime SHALL NOT 把未知引用降级为字符串、通用 sourceId 或 Prompt 拼接内容

#### Scenario: Browser receives a streamed answer

- **GIVEN** 浏览器通过 `/runs/stream` 提交带幂等标识的当前输入
- **WHEN** Runtime 创建或命中 Run 并调用流式模型生成
- **THEN** Demo Server SHALL 以 SSE 先发送 `run-started`，再发送零到多个工具阶段事件或 `text-delta`，以及一个 `completed`、`cancelled` 或 `error` 终止事件
- **AND** `text-delta` SHALL 只在内存和网络层传递，不得逐 Token 写入 SQLite
- **AND** 成功完成后 Runtime SHALL 在同一事务中只持久化一条完整助手消息和 Run 最终状态
- **AND** 浏览器断线 SHALL NOT 创建回答 checkpoint 或 Token 级续传状态
- **AND** 渠道 SHALL 能通过会话详情中的 `latestRun` 查询最终状态

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

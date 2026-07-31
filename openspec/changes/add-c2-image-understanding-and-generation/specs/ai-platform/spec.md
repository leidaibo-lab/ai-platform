## ADDED Requirements

### Requirement: C2 image operation boundary

系统 SHALL 在现有 Conversation Run 事实模型内提供显式的 C2 图片操作，并保持 C1 会话入口、Agent Runtime 和模型网关的单向依赖。

#### Scenario: Channel starts an image understanding run

- **WHEN** 渠道向 active Conversation 提交 `operation=image.understand`、非空问题和至少一个可访问的 `image_asset` 引用
- **THEN** Runtime SHALL 创建幂等 Run、解析并校验资产后调用具备 `image-input` 能力的平台模型别名
- **AND** Runtime SHALL 返回文本或经过 schema 校验的结构化理解结果

#### Scenario: Channel starts an image generation run

- **WHEN** 渠道向 active Conversation 提交 `operation=image.generate`、非空提示词和平台允许的通用图片选项
- **THEN** Runtime SHALL 创建幂等 Run 并通过 GatewayClient 和 LiteLLM 调用具备 `image-output` 能力的平台模型别名
- **AND** 浏览器 SHALL NOT 接收 provider key、真实上游地址或任意 provider 专属参数透传能力

#### Scenario: Existing conversation run omits image operation

- **WHEN** 现有客户端提交不包含 `operation` 的 Conversation Run
- **THEN** Runtime SHALL 保持当前 C1 文本和 `imageUrls` 兼容行为
- **AND** Runtime SHALL NOT 因本变更把普通对话隐式改为图片生成

### Requirement: Controlled image assets

系统 SHALL 使用 Runtime 可鉴权的 `image_asset` 作为 C2 输入和输出的稳定图片事实，并将资产元数据与图片二进制的存储职责分离。

#### Scenario: Channel uploads a valid image asset

- **WHEN** 渠道向目标 Conversation 的受控图片资产入口上传允许格式且满足数量、字节和尺寸限制的图片
- **THEN** 系统 SHALL 在模型调用前验证真实 MIME、解码完整性和媒体限制
- **AND** 系统 SHALL 返回包含稳定 `assetId`、版本、MIME、尺寸、哈希、状态和生命周期字段的资产引用
- **AND** SQLite SHALL 只持有资产元数据与引用关系，图片二进制 SHALL 由 ImageAssetStore Port 的实现持有

#### Scenario: Image asset validation fails

- **WHEN** 图片的声明类型与真实内容不符、无法解码、超过限制或不满足媒体安全策略
- **THEN** 系统 SHALL 返回稳定的媒体错误类别
- **AND** 系统 SHALL NOT 创建可用资产或调用任何模型

#### Scenario: Conversation references an inaccessible image asset

- **WHEN** Run 引用了不存在、已过期或不属于当前授权上下文的 `image_asset`
- **THEN** Runtime SHALL 在模型调用前拒绝请求
- **AND** 渠道 SHALL NOT 获得物理存储路径、其他会话元数据或签名地址

### Requirement: C2 image understanding governance

系统 SHALL 在现有图片透传基础上增加媒体治理、视觉能力路由、多轮资产引用和逐图结果语义，不得把“模型返回非空文本”作为 C2 完成标准。

#### Scenario: Selected model lacks image input capability

- **WHEN** `image.understand` 选择的平台模型别名没有声明 `image-input` 能力
- **THEN** Runtime SHALL 在调用模型前返回稳定的模型能力错误
- **AND** Runtime SHALL NOT 静默删除图片后按纯文本请求继续

#### Scenario: One image in a multi-image request fails

- **WHEN** 多图理解中至少一个资产无法解析、读取或满足模型限制
- **THEN** Runtime SHALL 返回可关联到对应 `assetId` 的逐图错误
- **AND** Runtime SHALL 按稳定策略决定拒绝整个 Run 或仅处理有效图片，并在结果中明确处理范围

#### Scenario: User refers to an earlier image asset

- **WHEN** 用户在后续 Run 中显式引用当前授权范围内的历史 `image_asset`
- **THEN** Context Planner SHALL 按资产 ID、版本、派生 OCR/caption 和视觉预算装箱所需上下文
- **AND** Runtime SHALL NOT 仅因为历史 Message 保存过临时 URL 就无条件重发所有原图

### Requirement: C2 image generation result

系统 SHALL 将图片生成建模为产生新 `image_asset` 的 C2 操作，并在资产持久化和内容安全完成后才交付结果。

#### Scenario: Image generation completes successfully

- **WHEN** 图片模型返回满足格式要求且通过输出安全策略的一个或多个图片结果
- **THEN** Runtime SHALL 先持久化图片二进制和资产元数据，再把 Run 标记为 `completed`
- **AND** JSON 结果和最终 Message SHALL 返回稳定 `image_asset` 引用及最小可公开元数据
- **AND** POST SSE SHALL 通过结构化 `artifact-created` 事件交付资产引用，并继续使用 `completed` 事件收口

#### Scenario: Generated image cannot be persisted

- **WHEN** 图片模型已经返回结果但 ImageAssetStore 或元数据事务失败
- **THEN** Runtime SHALL 把 Run 标记为明确失败并记录已经越过模型生成边界的安全证据
- **AND** Runtime SHALL NOT 自动再次调用图片模型
- **AND** 适配器 SHALL 清理未成为可引用事实的临时图片数据

#### Scenario: Generated image fails output policy

- **WHEN** 生成结果未通过当前版本的输出安全策略
- **THEN** 系统 SHALL 保持该资产不可交付并向渠道返回稳定拒绝类别
- **AND** 普通日志、Trace 和渠道响应 SHALL NOT 包含审核服务原始响应或图片二进制

### Requirement: C2 generation idempotency and cancellation

系统 SHALL 让图片生成继承 Run 的 requestId 幂等、绝对截止时间和取消语义，并防止重放或不确定失败造成静默重复生成与重复计费。

#### Scenario: Completed image generation is replayed

- **WHEN** 客户端使用相同 `requestId` 重放已经完成的 `image.generate` Run
- **THEN** Runtime SHALL 返回原 Run 和原 `image_asset` 引用
- **AND** GatewayClient SHALL NOT 再次调用图片模型

#### Scenario: Image generation result is uncertain

- **WHEN** 图片模型请求超时、连接中断或响应丢失，且平台无法证明 provider 未生成图片或端到端幂等生效
- **THEN** Runtime SHALL 返回稳定的不确定结果错误并保留安全尝试证据
- **AND** Runtime 与 AI SDK SHALL NOT 自动重试图片生成

#### Scenario: User cancels an image generation run

- **WHEN** 用户在图片模型或资产写入仍可取消的阶段取消 Run
- **THEN** Runtime SHALL 传播同一个取消信号并把 Run 收口为稳定取消状态
- **AND** 若外部系统已经产生不可逆结果，Runtime SHALL 记录真实边界而不是把取消表示为从未执行

### Requirement: C2 model policy, cost, and evaluation

系统 SHALL 为 C2 建立独立的模型能力白名单、媒体用量、生成成本和四维质量证据，且不得把 C1 文本评测结果等同于 C2 验收。

#### Scenario: Channel submits unsupported image options

- **WHEN** 渠道提交超出平台模型策略的图片数量、尺寸、宽高比或其他参数
- **THEN** Runtime SHALL 在模型调用前返回稳定请求约束错误
- **AND** GatewayClient SHALL NOT 把未知 provider 参数原样透传

#### Scenario: Platform records a C2 run

- **WHEN** C2 Run 完成、失败或取消
- **THEN** Runtime SHALL 记录模型别名、图片数量与尺寸、视觉计费或生成张数、阶段耗时、成本证据和稳定错误类别
- **AND** Trace SHALL NOT 记录图片二进制、完整提示词、临时访问地址或 provider 响应正文

#### Scenario: C2 capability is declared available

- **WHEN** 维护者准备声明图片理解或图片生成达到基础可用
- **THEN** 图片理解 SHALL 通过截图、OCR、表格、文档照片和多图关联 fixture
- **AND** 图片生成 SHALL 通过提示词一致性、图片有效性、内容安全、耗时、幂等和失败路径验收
- **AND** 未执行的真实模型或运行态验证 SHALL 保持为明确 TODO，不得写成已完成能力

## MODIFIED Requirements

### Requirement: OpenAI-compatible proxy

系统 SHALL 通过 LiteLLM Proxy 暴露 OpenAI-compatible API，供 Agent Runtime 和本地模型连通性诊断访问 gateway；上游对话与图片模型可以使用相互隔离的服务端凭据。

#### Scenario: Gateway receives chat completions

- **GIVEN** LiteLLM Proxy 已启动
- **AND** `.env` 提供了 `LITELLM_MASTER_KEY`、`UPSTREAM_API_BASE` 和对话模型使用的 `UPSTREAM_API_KEY1`
- **WHEN** Agent Runtime 或模型连通性测试请求 `POST /v1/chat/completions`
- **AND** 请求使用 `Authorization: Bearer LITELLM_MASTER_KEY`
- **THEN** 系统 SHALL 将请求转发到配置的上游 OpenAI-compatible API
- **AND** 系统 SHALL 返回 OpenAI-compatible 响应

#### Scenario: Gateway receives image generations

- **GIVEN** LiteLLM Proxy 已启动
- **AND** `.env` 提供了图片模型使用的 `UPSTREAM_API_KEY2`
- **WHEN** Agent Runtime 经 GatewayClient 请求 `POST /v1/images/generations`
- **AND** 请求使用 `Authorization: Bearer LITELLM_MASTER_KEY`
- **THEN** LiteLLM SHALL 使用图片别名对应的上游映射和服务端 key 转发请求
- **AND** Runtime、渠道和浏览器 SHALL NOT 获取 `UPSTREAM_API_KEY2`

### Requirement: Model alias routing

系统 SHALL 向 Runtime GatewayClient 和模型连通性诊断提供稳定模型别名，并在模型网关服务端配置中映射到真实上游模型。

#### Scenario: Runtime or diagnostics uses configured chat alias

- **GIVEN** `config.yaml` 中存在 `model_name: gpt-5.6` 且服务端 `LITELLM_MODEL=gpt-5.6`
- **WHEN** Runtime GatewayClient 或 `scripts/test-chat.sh` 发送当前 `LITELLM_MODEL`
- **THEN** LiteLLM SHALL 使用 `litellm_params.model` 指定的真实对话模型调用上游
- **AND** Runtime 和诊断脚本不需要知道真实上游模型名

#### Scenario: Runtime uses configured image alias

- **GIVEN** `config.yaml` 中存在 `model_name: gpt-image-2` 且服务端 `LITELLM_IMAGE_MODEL=gpt-image-2`
- **WHEN** Runtime 执行 `image.generate`
- **THEN** GatewayClient SHALL 只把 `gpt-image-2` 平台别名交给 LiteLLM
- **AND** LiteLLM SHALL 使用图片别名对应的 `litellm_params.model` 与 `UPSTREAM_API_KEY2` 调用上游

#### Scenario: Browser selects a gateway-visible model alias

- **GIVEN** LiteLLM `/v1/models` 返回当前服务端 key 可见的模型别名
- **WHEN** 浏览器在会话 Sender 中选择一个别名并通过 Run 请求提交 `model`
- **THEN** Runtime SHALL 校验并使用该别名执行当前 Run 的模型生成；对话 Run 的 token counter SHALL 使用同一别名
- **AND** 生图模式 SHALL 固定使用服务端 `LITELLM_IMAGE_MODEL` 对应且网关可见的别名
- **AND** GatewayClient SHALL 继续只把模型别名交给 LiteLLM，不得向浏览器返回真实上游模型配置
- **AND** 对话 Run 未提供 `model` 时 SHALL 回退服务端 `LITELLM_MODEL`
- **AND** 非默认且不在当前网关可见模型集合中的别名 SHALL 被拒绝

### Requirement: Server-side secret boundary

系统 SHALL 将模型网关访问凭据和上游真实 key 保持在服务端环境变量中，不得暴露给浏览器、渠道或普通业务客户端。

#### Scenario: Browser uses demo

- **GIVEN** 浏览器打开 Demo 页面
- **WHEN** 用户发送文本、图片、文档链接或图片生成提示词
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

### Requirement: Gateway status endpoint

Demo Server SHALL 提供状态检查接口，返回 LiteLLM 连接状态、gateway base url、对话模型别名和服务端图片模型别名。

#### Scenario: Browser checks status

- **GIVEN** Demo Server 已启动
- **WHEN** 浏览器请求 `GET /api/gateway/status`
- **THEN** Demo Server SHALL 尝试请求 LiteLLM `/v1/models`
- **AND** 响应 SHALL 包含 `ok`、`gatewayBaseUrl`、默认对话别名 `model`、服务端图片别名 `imageModel` 和当前 key 可见的别名数组 `models`
- **AND** 该状态 SHALL 只表示模型目录可达，不得表述为上游生成可用

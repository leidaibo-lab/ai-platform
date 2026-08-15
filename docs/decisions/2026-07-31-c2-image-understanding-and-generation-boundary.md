# C2 图片理解与生成能力边界

- 状态：接受
- 日期：2026-07-31
- 负责人：AI 应用基础平台维护者
- 所属区域：渠道与体验层 / Agent Runtime / 连接器与知识层 / 模型网关 / 治理与可观测
- 关联需求：将图片生成结合到现有 C2 链路，同时保持 C1 会话入口和平台单向依赖
- 关联 OpenSpec：`openspec/changes/add-c2-image-understanding-and-generation/`
- 替代记录：无；扩展 `docs/scenario-interaction-chains.md` 中原有 C2 图片理解边界

## 问题

本次决策前，C2 只把图片 URL 或 data URL 作为多模态输入透传给视觉模型，缺少受控图片资产、媒体安全、视觉能力路由和稳定评测，也没有图片生成运行时。图片生成与图片理解共享图片资产、权限、生命周期、安全、成本和渠道交付。如果把生图塞进 C1 文本生成，C1 将同时拥有会话编排和图片领域数据；如果另起完全独立场景，又会重复建设相同媒体底座。

本记录先决定场景归属和内部边界，并在首个实现切片中接受 AI SDK 图片接口、本地受控资产目录和 SQLite 元数据组合。成功证据是：C1 仍是统一会话入口；C2 同时容纳图片理解与生成，并以独立操作和结果契约复用同一 `image_asset`。`gpt-image-2 -> openai/gpt-image-2` 已通过一次真实 happy-path smoke，证明当前组合可以生成、校验、落存和读取图片；内容审核、真实异常矩阵、成本与生产质量仍必须由后续 PoC 确认。

## 约束与非目标

### 必须满足

- 所有图片理解和生成请求都经过 Agent Runtime，再调用媒体连接器和模型网关，不形成浏览器直连 provider 的第二入口。
- C1 继续拥有 Conversation、Message、Run、幂等、取消和结果交付；C2 拥有图片操作语义与 `image_asset` 生命周期。
- 图片二进制不得直接长期写入 Conversation、Message、Run、普通日志或 Trace；稳定事实只保存资产 ID 和受控元数据。
- 图片理解与图片生成使用独立输入、输出、错误和评测契约，不能仅靠 Prompt 文本猜测结果类型。
- 生图重放不得重复调用模型或重复计费；没有 provider 幂等证据时不得自动重试不确定结果。
- 当前 `imageUrls` 输入保持兼容，受控 `image_asset` 引用作为新增路径逐步替代临时 URL。

### 本次不解决

- 首个 PoC 使用 `gpt-image-2` 平台别名和 `openai/gpt-image-2` 上游映射，但不据此锁定生产图片模型、审核服务或部署拓扑；当前本地文件 Adapter 只服务开发切片。
- 不实现图生图、局部重绘、遮罩、风格训练、批量离线生图或人工精修工作台。
- 不把 C2 拆成独立服务；达到独立数据、安全、扩缩容或团队所有权条件后再评估。
- 不把模型原始二进制、内部提示词或审核响应正文暴露到渠道或 Trace。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| C2 统一图片能力域，内部拆分理解与生成 | 轻量可组合 | C1 会话入口、C2 `image.understand` / `image.generate`、共享 `image_asset` | 复用媒体资产与治理，同时保持操作契约独立；符合现有场景链和单向依赖 | C2 名称和稳定契约需要扩展；生成链仍需独立技术选型 | `docs/scenario-interaction-chains.md`、`openspec/project.md` |
| 保留 C2 图片理解，新增 C8 图片生成 | 成熟分域 | 理解和生成完全分离，各自拥有入口和资产 | 领域名称最直观，未来可独立扩缩容 | 当前阶段重复建设上传、存储、权限、安全和渠道交付，场景数量随模态操作膨胀 | `docs/scenario-interaction-chains.md` 的共同底座与引用语义 |
| 将生图直接并入 C1 文本会话 | 最小改动 | 在现有 Run 中增加图片结果 | 渠道改动表面最少 | C1 获得图片资产所有权，文本协议承载二进制或临时 URL，理解/生成错误和成本语义混杂 | `openspec/specs/ai-platform/spec.md` 的现有 Conversation Run 契约 |

图片模型调用检索了三条实施路线：复用 AI SDK `generateImage` 与 `@ai-sdk/openai-compatible` 经 LiteLLM 调用、在 Runtime Port 后直接适配 LiteLLM 图片 HTTP API、以及直连 provider SDK。首个开发切片采用第一条：它复用锁定依赖、现有 GatewayClient 和 LiteLLM 鉴权边界，fake LiteLLM 已证明请求落到 `/v1/images/generations` 并返回稳定二进制，真实 happy-path 进一步证明当前 `gpt-image-2` 组合可用。provider usage 只有生成张数且请求尺寸未被精确保持；取消、超时、错误和内容安全仍待真实验证。若后续兼容矩阵失败，则退出到 GatewayClient 内部 HTTP Adapter，不改变 Runtime Run 与 `image_asset` 契约。

## 淘汰条件

- 绕过 Agent Runtime 或 LiteLLM 直接暴露 provider key、模型 ID 或 provider 专属参数。
- 让模型网关或渠道成为 `image_asset` 的事实所有者。
- 把图片 base64、临时 provider URL 或签名 URL作为长期稳定引用。
- 幂等重放、超时或网络断开可能静默产生多份图片和多次费用。
- 模型不支持视觉或生图时静默降级为文本回答。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 现有链路具备图片理解传输与真实模型调用基础 | 运行 GatewayClient 多模态映射测试，并通过完整 Runtime 主链执行真实视觉 smoke | `ai@7.0.37`、`@ai-sdk/openai-compatible@3.0.14`、图片 data URL、`gpt-5.6 -> openai/gpt-5.6-sol` | fake 映射与两次真实视觉请求已通过；证明当前映射可完成图片理解，不证明受控资产治理和视觉质量基线 | `scripts/test-gateway-client.mjs`、`src/runtime/message-builder.mjs`、本地 SQLite Run 证据 |
| 当前 SDK 可承载独立图片模型调用 | 核对锁定依赖，运行 fake LiteLLM 协议测试与真实 Runtime smoke | `ai@7.0.37`、`@ai-sdk/openai-compatible@3.0.14`、`gpt-image-2` | 静态、fake HTTP 与真实 happy-path 已通过；真实异常矩阵仍待完成 | `scripts/test-gateway-client.mjs`、`src/gateway/gateway-client.mjs`、本地 SQLite Run 证据 |
| C2 可复用一个稳定图片资产类型 | 运行生成、落盘、读取和会话恢复测试 | `image_asset` 生成产物 | 生成侧已实现；理解输入、多轮引用和正式生命周期仍待实现 | `scripts/test-image-generation.mjs`、`src/storage/conversation-store.mjs` |
| 生图可继承现有 Run 重放语义 | 模拟完成、取消、资产写入失败和同一 `requestId` 重放 | 单张文生图、无 provider 幂等假设 | 已通过 fake 回归；同 requestId 不重复调用，图片模型固定单次尝试 | `scripts/test-image-generation.mjs`、`scripts/test-streaming-http.mjs` |

### 真实 PoC 结果

- 2026-07-31 通过 `Agent Runtime -> GatewayClient -> AI SDK -> LiteLLM -> openai/gpt-image-2` 执行单张文生图，HTTP 与 Run 均完成；模型调用 `maxAttempts=1`、`attemptCount=1`，耗时 41,737 毫秒。
- 请求 `1024x1024`，实际返回 `image/png`、`1254x1254`、1,091,928 字节；平台读取真实图片头、计算 SHA-256，并以实际尺寸完成 `image_asset`、Message 和 Run 引用。
- usage 为 `generated_images: 1`，`input_tokens`、`output_tokens`、`total_tokens` 均为空，未返回可用于成本基线的字段。
- 本地证据对应 `conversationId=799eff46-f7e9-4632-9807-35826a1cefca`、`runId=d4ee5532-ac79-40b7-a6c5-f94d414c1d54`。该证据是开发环境单样本，不是长期可复现的生产评测数据集。
- 结论只确认当前适配路线的 happy path；请求尺寸必须视为偏好，资产实际尺寸才是事实。内容安全、真实取消、超时、错误、成本和多样本质量仍未验收。

## 决策

- 结论：适配
- 选择方案：把 C2 扩展为“图片理解与生成”能力域，内部使用 `image.understand` 和 `image.generate` 两条独立操作；未来图片编辑在同一资产底座上增加 `image.edit`，但不进入首个切片。
- 首个技术切片：GatewayClient 使用 AI SDK `generateImage` 和 openai-compatible `imageModel()` 经 LiteLLM 调用；服务端以 `LITELLM_IMAGE_MODEL=gpt-image-2` 选择平台别名，真实 key 仅由 LiteLLM 的 `UPSTREAM_API_KEY2` 使用；图片二进制由本地 `ImageAssetStore` Adapter 持有，SQLite 只保存元数据与 Message/Run 引用。
- 决策依据：图片理解和生成的输入输出方向不同，但共享媒体资产、权限、安全、成本和交付。统一归入 C2 可以复用领域底座；独立操作可以避免把生成的副作用、费用和结果类型混入理解链。
- 平台拥有：C2 Runtime 契约、`image_asset` 元数据和生命周期、幂等与状态、模型能力白名单、媒体安全、结果交付、成本与评测。
- 外部方案负责：图片模型执行、对象二进制存储和内容审核的通用能力，最终通过 Port/Adapter 接入。
- 明确不实现：不自研图片生成模型、视觉算法、对象存储协议、恶意文件扫描引擎或通用审核模型。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| 新增 C8 图片生成 | 当前规模没有独立数据所有权和团队边界，拆分只会复制媒体治理 | 生图形成独立产品、独立配额、安全域、扩缩容或团队所有权 |
| 生图直接归入 C1 | C1 应保持会话编排，不能拥有图片资产与图片模型语义 | 不重评；C1 可以作为入口，但不成为图片能力所有者 |
| 浏览器直连图片 provider | 泄露密钥并绕过 Runtime 的幂等、取消、审计和成本治理 | 不重评 |

## 实施边界

C1 渠道继续提交会话 Run；渠道显式选择图片操作，或者未来由受控 Agent 路由到同一个 C2 应用服务。Runtime 负责校验操作、幂等和截止时间，按 `image_asset` ID 从媒体连接器解析输入；图片理解经 GatewayClient 调用视觉语言模型并返回文本或结构化结果，图片生成经独立图片模型 Port 调用模型网关并把结果先写入资产存储，再以稳定资产引用完成 Run。渠道只解析 Runtime 返回的资产引用和短期展示地址。

首个实现不得依赖自然语言意图分类作为唯一入口，也不得把 `generateImage` 嵌进浏览器。图片模型 Adapter、资产 Store 和安全策略通过 Port 隔离；LiteLLM 继续拥有 provider 路由与 key，Runtime 不感知真实 provider key。

## 风险与退出路径

- 已知风险：LiteLLM 与具体图片 provider 对尺寸、数量、返回格式、取消和幂等支持不一致；当前已观察到请求 `1024x1024` 实际返回 `1254x1254`，因此只开放通用请求白名单，交付以实际资产元数据为准，不向渠道透传任意 provider 参数。
- 锁定点：`image_asset` 元数据、OpenAI-compatible 图片 API、AI SDK ImageModel 结果类型和对象存储地址格式。
- 退出路径：Runtime 依赖项目自有 ImageModelClient 与 ImageAssetStore Port；更换 SDK、LiteLLM 路径或存储时不迁移 Conversation/Run 契约，只迁移资产元数据或二进制。
- 维护责任：AI 应用基础平台维护者负责 Runtime 契约、Adapter、资产治理和回归；模型网关维护者负责模型别名、密钥、配额和 provider 兼容。

## 验收与完成报告

- 验证证据：已完成 fake LiteLLM 图片协议、单次尝试、结果校验、资产落存/读取、幂等重放、取消、写入失败和 SSE 顺序回归；另完成一次真实模型 happy-path、图片有效性和提示词一致性观察。
- 剩余边界：真实模型取消/超时/错误矩阵、图片理解资产输入、审核方案、资产保留期、正式对象存储、尺寸能力目录和成本阈值待定。
- 文档与契约：本记录关联独立 OpenSpec change；实现时同步 `docs/scenario-interaction-chains.md`、`docs/ai-sdk-core-alignment.md`、README 和稳定 spec。
- 重评条件：出现独立图片产品、跨项目资产复用、生产数据驻留要求、异步批量生图、图片编辑或独立扩缩容需求。

## 2026-08-02 图片理解模型兼容补充

- 图片理解继续走 `conversation.chat` 的多模态消息路径，必须选择同时属于 `chat` 与 `vision` 能力分组的语言模型；`gpt-image-2` 是图片生成/编辑别名，不得用于 Chat Completions 或图片理解。
- 当前稳定对话别名 `gpt-5.6` 映射到上游真实模型 `openai/gpt-5.6-sol`。修正映射后，1x1 测试 PNG 和一张真实架构截图均通过 `Agent Runtime -> GatewayClient -> AI SDK -> LiteLLM` 单次完成图片内容识别。
- `/v1/models` 中出现别名只证明路由对当前 key 可见，不证明该别名具备 `chat`、`vision`、`imageGeneration` 或 `imageEditing` 能力。Runtime 必须在模型调用前按 operation 和输入模态校验能力；错配统一返回 `model_capability_mismatch`。
- 图片模型的 `imageGeneration` / `imageEditing` 声明只描述端点与操作兼容边界，不代表当前上游账号池持续健康。既有证据包括文生图真实 happy path、旧 `/images/edits` 三次无兼容账号、2026-08-02 Responses 图片工具拒绝，以及 2026-08-15 当前配置两轮真实编辑成功；映射或 key 变化后仍需重复 smoke，不能由能力声明直接推断可用。
- 真实视觉 smoke 只补齐当前 data URL 图片理解主路径；受控 `image_asset` 理解输入、多轮引用、媒体安全、稳定视觉 fixture 和质量基线仍是后续边界。

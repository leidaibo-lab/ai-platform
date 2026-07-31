## Context

当前浏览器和 Conversation Run 已接受 `imageUrls`，Runtime 将其转换为 OpenAI-compatible `image_url`，GatewayClient 再转换为 AI SDK FilePart，经 LiteLLM 交给视觉语言模型。这条链只证明图片传输，不校验真实 MIME、大小、数量、远程地址安全或模型视觉能力；图片 URL 也没有稳定资产身份，历史消息保存了原始内容不代表 Context Planner 会在后续 Run 中持续携带图片。

本 change 建立前，图片生成尚无入口、模型调用、资产存储和结果契约。C1 已经拥有会话、Run、幂等、取消、重试和交付，因此 C2 应复用这些事实，而不是另建任务系统；同时 C1 不能拥有图片二进制、图片模型参数和媒体生命周期。关联边界记录为 `docs/decisions/2026-07-31-c2-image-understanding-and-generation-boundary.md`。

首个 PoC 在 LiteLLM 配置中使用 `gpt-image-2 -> openai/gpt-image-2`，并通过服务端 `LITELLM_IMAGE_MODEL` 与 `UPSTREAM_API_KEY2` 隔离图片别名和真实 key；fake 回归与一次真实 happy-path 已通过。真实调用申请 `1024x1024`、实际返回 `1254x1254` PNG，usage 只有生成张数；这证明当前组合可调用，不代表精确尺寸、成本、内容安全或异常矩阵已经验证。

## Goals / Non-Goals

**Goals:**

- 保持 C1 为会话入口，在同一 Run 事实模型下显式执行 `image.understand` 或 `image.generate`。
- 建立 C2 共同的 `image_asset`、媒体校验、权限、生命周期、安全和结果交付边界。
- 保持现有 `imageUrls` 兼容，同时为多轮图片理解和生成结果提供稳定资产引用。
- 让图片生成遵守平台幂等、取消、截止时间、模型白名单、成本和敏感数据约束。
- 通过 Port 隔离模型 SDK、LiteLLM、对象存储和审核实现，保持模块化单体可替换。

**Non-Goals:**

- 首个切片不支持 `image.edit`、图生图、遮罩、局部重绘、批量离线任务或独立图片服务。
- 不依赖自然语言意图分类作为唯一图片操作入口，不要求语言模型先调用工具再触发图片模型。
- 不允许渠道透传任意 provider 参数、真实模型名、provider key 或存储地址。
- 不在稳定消息、日志或 Trace 中保存图片二进制、签名 URL、完整提示词或审核响应正文。

## Decisions

### 1. 复用 Conversation Run，增加显式图片操作

现有 Run 请求增加可选 `operation`，缺省保持当前 C1 行为。首期新增：

- `image.understand`：输入 `message` 与一个或多个 `image_asset` 引用，输出文本或经过 schema 校验的结构化结果。
- `image.generate`：输入 `message` 作为用户可见提示词，并接受平台白名单内的通用图片选项，输出一个或多个新 `image_asset`。

渠道可以提供明确的理解/生成模式；未来 Agent 自动路由只能调用同一个 C2 应用服务，不能形成第二套执行和事实路径。选择显式判别而不是仅靠 Prompt 猜测，是为了稳定校验、成本、错误和结果类型。

### 2. `image_asset` 是图片输入和输出的共同事实

新增受控图片资产入口，目标 API 为 `POST /api/runtime/conversations/{conversationId}/image-assets`。首个实现接收受限图片文件并返回稳定引用；当前 `imageUrls` 继续兼容，但不会自动获得跨 Run 生命周期保证。

资产元数据至少包括：`assetId`、`conversationId`、`version`、`mediaType`、`sizeBytes`、`width`、`height`、`sha256`、`source`、`status`、`createdAt` 和可空 `expiresAt`。SQLite 保存元数据和引用关系，图片二进制由 `ImageAssetStore` Port 管理。渠道通过受控读取端点获得当前展示内容，不把物理路径、provider URL 或长期签名 URL写入消息。

初期资产所有权按 Conversation 收敛；引入租户、应用或正式用户身份时，在保持 `assetId` 不变的前提下扩展授权上下文。

### 3. 媒体校验位于 Runtime 与存储之前

`MediaGuard` 负责数量、字节大小、真实 MIME、尺寸、解码完整性和允许格式；远程 URL 导入在完成 SSRF、防重定向绕过、下载上限和超时治理前不进入受控资产入口。校验失败不得写入可用资产，也不得调用模型。

内容审核使用独立 Policy Port。理解输入和生成提示词在模型调用前执行策略，生成结果在对渠道可见前执行策略；具体审核产品通过后续方案决策选择。

### 4. GatewayClient 扩展图片模型能力，不增加业务直连

Runtime 继续只依赖项目拥有的 GatewayClient Contract。GatewayClient Adapter 为图片生成增加 AI SDK `generateImage` 路径，使用 `@ai-sdk/openai-compatible` 的 `imageModel()` 经 LiteLLM `/images/generations` 调用。锁定版本和真实图片模型已经验证请求、有效图片结果与有限 usage；取消、超时、错误、内容安全、成本和尺寸兼容矩阵仍需继续验证。

视觉理解继续使用语言模型多模态路径。模型能力目录为每个平台别名声明 `text-input`、`image-input`、`text-output`、`image-output` 及大小、数量、宽高比等限制。渠道只能选择平台别名和通用白名单参数，GatewayClient 负责映射 provider 差异。

### 5. 生成结果先持久化资产，再完成 Run

图片模型返回的数据先写入 `ImageAssetStore`，元数据和 Run/Message 产物引用在 SQLite 中形成一致事实后，Run 才能进入 `completed`。JSON Run 返回 `artifacts`；POST SSE 增加结构化 `artifact-created` 事件，随后仍以 `completed` 收口。Message 保存资产引用，不保存图片二进制。

若模型已成功但资产写入失败，Run 进入明确失败状态并记录安全的生成尝试证据，不自动再次生图；临时二进制由适配器清理。若生成结果未通过审核，资产保持不可交付状态，渠道只收到稳定拒绝类别。

### 6. 图片生成默认不做隐式模型重试

同一 `requestId` 的已完成重放只返回原 Run 与原资产引用，不再次调用图片模型。首次生成调用向 AI SDK 传入 `maxRetries: 0`；只有真实 provider/LiteLLM PoC 证明可传递端到端幂等键并能识别不确定结果时，才允许在平台统一截止时间内增加自动重试。

取消信号覆盖排队、媒体解析、模型调用、资产写入前的可取消阶段。模型或存储已经产生不可逆结果后，取消只阻止后续交付，不伪造为“未执行”，并保留可审计状态。

### 7. C2 使用独立质量与可观测基线

图片理解分别评估截图、OCR、表格、文档照片和多图关系；图片生成分别评估提示词一致性、文字可读性、内容安全、图片有效性和耗时。每个阶段记录图片数量、尺寸、视觉计费或生成张数、模型别名、耗时和安全错误类别，Trace 只记录资产 ID 哈希和最小元数据。

## Risks / Trade-offs

- [LiteLLM 和 provider 的图片参数或返回格式不一致] -> 先固定单一图片模型完成 PoC，只开放平台通用参数白名单。
- [生成成功但响应丢失导致重复计费] -> 默认关闭 SDK 自动重试；只有端到端幂等得到证据后才开放自动重试。
- [本地资产存储无法满足多人共享] -> 通过 `ImageAssetStore` Port 隔离；当前保持模块化单体，触发数据驻留、独立扩缩容或跨项目复用后切换对象存储。
- [图片历史导致上下文和视觉成本快速增长] -> Context Planner 优先使用用户显式引用和派生 OCR/caption，不无条件重发全部历史原图。
- [审核误判阻断正常使用] -> 保存策略版本和稳定拒绝类别，提供可观测证据，但不向渠道暴露审核服务原文。
- [C2 范围扩张为图片编辑器] -> 首个切片只做理解治理和文生图；`image.edit` 需独立增量规格与交互验收。

## Migration Plan

1. 已完成单一真实生图模型 happy-path；继续完成视觉模型、资产存储、审核候选、异常矩阵和成本 PoC，补充参数与能力白名单。
2. 新增资产元数据迁移、`ImageAssetStore`、`MediaGuard` 和受控上传/读取入口；保持现有 `imageUrls` 行为。
3. 增加 `image_asset` 引用解析和 `image.understand`，完成逐图错误、多轮引用和视觉 fixture。
4. 扩展 GatewayClient 图片模型能力，增加 `image.generate`、资产落存、审核、幂等和结构化结果事件。
5. 更新渠道模式选择、上传与图片产物展示；完成 JSON/SSE、移动端、异常和真实模型验收。
6. 行为和证据稳定后把 delta 吸收到稳定 spec；回滚时关闭 C2 新操作和上传入口，保留已生成资产只读访问与现有 C1 `imageUrls` 兼容。

## Open Questions

- 哪些请求尺寸能被 `gpt-image-2` 精确保持，平台是否需要按模型能力做尺寸归一化？
- 当前上游不返回 token/cost 时，生成成本由 LiteLLM 账单、provider 账单还是平台价格目录补齐？
- 首个 `ImageAssetStore` 采用本地受控目录还是 S3-compatible 对象存储，保留期和清理责任由谁承担？
- 输入与生成结果审核采用 provider 原生策略、独立审核服务还是组合策略？
- 首个切片开放哪些图片格式、尺寸、宽高比和单 Run 数量上限？
- 图片资产的正式权限是否继续按 Conversation，还是在 C2 实现前已有租户/应用身份契约可复用？

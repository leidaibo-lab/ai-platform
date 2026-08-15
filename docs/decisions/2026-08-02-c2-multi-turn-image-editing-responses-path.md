# C2 多轮图片编辑采用 Responses 图片工具路径

- 状态：接受
- 日期：2026-08-02
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime
- 关联需求：上传图片后通过文字连续优化，每轮输出可作为下一轮源图
- 关联 OpenSpec：`openspec/changes/add-c2-image-editing/`
- 替代记录：`docs/decisions/2026-07-31-c2-image-editing-ai-sdk-path.md`

## 问题

目标用户需要上传一张已有图片，通过自然语言连续修改，并在每一轮获得可下载、可继续编辑的新版本。既有 `image.edit -> /images/edits` 已完成资产、Run、幂等和协议回归，但 2026-08-01 上游账号池连续三次拒绝该端点；该单次编辑协议也没有内聚表达会话式图片迭代。

成功证据分为两层：平台回归必须证明一轮 Responses 编辑会产生新的 `image_asset`，第二轮只引用上一轮输出资产且不会覆盖历史版本；运行态必须使用具备 GPT Image 工具权限的上游凭据返回真实可打开图片。平台回归通过不能替代上游权限验收。

## 约束与非目标

### 必须满足

- 所有请求继续经过 Agent Runtime、GatewayClient 和 LiteLLM，浏览器不得直连 provider。
- 本地 `image_asset` 是交付和续接事实源；每轮重新发送当前源资产，不依赖 provider 会话保留。
- Responses 请求用 `tool_choice` 强制选择 `image_generation`，并以 `action=edit` 强制执行编辑，不得由模型把明确编辑静默改成文本回答或重新生成。
- 当前 OpenAI-compatible 中转站不接受 `max_tool_calls`；Adapter 只声明唯一图片工具，并在响应侧严格要求恰好一个 completed 图片调用，不能在不确定 5xx 后自动降级重发。
- 源资产不可变；每轮使用新 requestId 创建新 Run 和新输出资产。
- 图片副作用固定单次尝试，LiteLLM 对承载编辑的模型别名关闭内部重试。
- 图片、完整提示词、data URL、provider 响应和上游错误正文不得进入普通日志或 Trace。

### 本次不解决

- 遮罩、局部重绘、多图融合、图层编辑、批处理和人工精修工作台。
- provider `previous_response_id` 或图片 ID 的长期续接；它们不能替代本地资产事实。
- 自动把“视觉理解后文生图”冒充原图编辑。
- 上游账号开通、组织验证、内容审核、成本基线和生产可用声明。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| OpenAI Responses API `image_generation` 工具 | 成熟一体化 | 图片输入、编辑工具和多轮上下文 | 官方明确推荐用于 conversational editable image experiences，支持 `action=edit` 和多轮迭代 | 上游能力会随账号池或映射变化；openai-compatible SDK 尚无该 Adapter | [OpenAI Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)；2026-08-02 与 2026-08-15 本地 PoC |
| AI SDK `generateImage` + `/images/edits` | 轻量可组合 | 单次图片编辑 | 锁定依赖已实现 multipart，现有 fake 回归完整 | 当前账号池三次无兼容账号；不内聚多轮会话语义 | 被替代决策与 `scripts/test-gateway-client.mjs` |
| 视觉分析后调用 `/images/generations` 参考重绘 | 最小自研 | 当前凭据下的近似风格重建 | 可复用已成功的视觉理解和文生图链 | 不能保证像素、文字、人物或构图保真，不等价于图片编辑 | 当前 C2 真实 smoke 证据 |

## 淘汰条件

- 绕过 Runtime 或 LiteLLM，向浏览器暴露 provider key、上游地址或真实模型 ID。
- 依赖 provider 会话状态作为唯一事实，导致本地无法重放、迁移或审计。
- 在明确 `image.edit` 中使用 `action=auto`，或把参考重绘静默标记为编辑成功。
- 自动重复可能计费的图片工具请求。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 官方推荐 Responses 承载会话式图片编辑 | 核对官方指南的 API 选择、多轮和 `action` 语义 | 2026-08-02 官方页面 | 通过；单次编辑推荐 Image API，会话式可编辑体验推荐 Responses API | [OpenAI Image generation guide](https://developers.openai.com/api/docs/guides/image-generation) |
| 当前 LiteLLM 能代理 Responses | 使用平台别名执行最小文本请求 | `gpt-5.6` | 通过；HTTP 200 completed | 本地脱敏 PoC |
| 2026-08-02 上游允许 Responses 图片工具 | 使用 256x256 合成 PNG、文本指令和 `action=edit` | `gpt-5.6` | 不通过；LiteLLM 返回 502，上游拒绝图片工具访问 | 本地脱敏 PoC |
| 2026-08-15 当前配置支持真实连续编辑 | 上传 1800x1200 PNG，在默认智能模式连续执行两轮优化并刷新会话 | `gpt-5.6` | 通过；两次单尝试均完成，第二轮只引用第一轮输出，A/B/C 哈希不同且两个输出刷新后可读 | 本地脱敏 Runtime、SQLite 与浏览器 smoke |
| 当前兼容上游接受图片工具约束字段 | 使用同一无业务信息合成 PNG 对照 `action=edit`、增加 `tool_choice`、再增加 `max_tool_calls=1` | `gpt-5.6` | 前两种分别约 33.5 秒和 30.7 秒返回 200 图片结果；加入 `max_tool_calls` 后返回上游 502，因此保留 `tool_choice` 并省略该字段 | 2026-08-15 本地脱敏协议对照 |
| 本地资产契约可表达多轮 | 审计第二轮引用上一轮输出的 Run/Message/Asset 链 | 当前 Runtime 与 SQLite Store | 通过；无需新增数据库字段 | `src/runtime/chat-runtime.mjs`、`src/storage/conversation-store.mjs` |

## 决策

- 结论：适配
- 选择方案：在 GatewayClient Port 内增加最小、受控的 Responses 图片编辑 HTTP Adapter；`image.generate` 继续使用 AI SDK `generateImage`，`image.edit` 改用 `/v1/responses` 的 `image_generation` 工具和 `action=edit`。
- 决策依据：Responses 是官方针对会话式、可连续编辑图片体验的成熟协议；平台只适配锁定 SDK 暂未覆盖的请求/响应边界，并继续拥有资产、权限、幂等、取消和交付语义。
- 平台拥有：`image.edit` Run、受控资产、源版本链、操作能力路由、单次尝试、错误脱敏、结果校验和多轮渠道状态。
- 外部方案负责：图片编辑模型执行、Responses 工具语义、上游安全策略和账号权限。
- 明确不实现：图片算法、provider 会话数据库、通用工作流引擎或未经标注的参考重绘。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| 继续以 `/images/edits` 作为主路径 | 三次真实请求均无兼容账号，且用户目标是连续编辑而非一次性转换 | 上游恢复该端点且 Responses 工具质量、成本或兼容性明显更差 |
| 视觉分析 + 文生图作为自动降级 | 结果不是原图编辑，静默降级会破坏用户预期和审计语义 | 产品明确增加独立“参考重绘”操作并接受保真限制 |
| provider SDK 直连 | 破坏统一模型访问、密钥和路由边界 | LiteLLM 长期无法代理标准 Responses，且可通过同一 GatewayClient Port 保持边界 |

## 实施边界

Runtime 仍只把一条当前会话 `image_asset` 引用交给 GatewayClient。Responses Adapter 将已校验字节编码为请求局部 data URL，使用主线模型平台别名、`tool_choice={type:image_generation}` 和 `store=false` 发起一次 `/v1/responses` 请求，仅读取唯一 completed `image_generation_call.result`。当前中转站对 `max_tool_calls` 的 502 对照证据表明该字段不能进入兼容请求；若未来上游明确支持，需重新执行相同三组协议 smoke 后再评估启用。返回字节继续经过现有格式、大小和尺寸校验后创建新资产。

渠道在成功后把新资产设为当前编辑源。普通后续发送默认提交 `operation=auto`，由 Runtime 把单张受控资产的候选限制为 `conversation.chat | image.edit`，且只有编辑意图 `confidence >= 0.85` 时执行编辑；用户从历史图片选择“继续编辑”仍提交显式 `image.edit`。两种入口都创建普通新 Run，不设置 recovery 字段。刷新或切换会话时只恢复稳定资产，不持久化本地未上传 data URL。智能路由的阈值、回退和持久化边界由 `docs/decisions/2026-08-02-runtime-smart-operation-routing.md` 单独治理。

## 风险与退出路径

- 已知风险：当前配置已通过两轮真实 smoke，但上游账号池、映射或模型版本变化仍可能重新失去 `image_generation` 工具能力；少量成功样本也不能替代生产健康度、质量和成本验收。
- 兼容风险：省略 `max_tool_calls` 意味着调用次数不能由当前上游请求字段约束；平台以唯一工具、强制选择、单次 HTTP 尝试和唯一结果解析收口，但仍需通过 provider 账单与调用日志建立生产级重复计费检测。
- 失败边界：LiteLLM 已接收但上游以 5xx 拒绝图片工具时，Runtime 返回脱敏的 `image_edit_provider_unavailable` 和协议/权限配置建议，不把该问题泛化为只需反复重试的普通抖动。
- 锁定点：Responses `/v1/responses`、`input_image` data URL、`image_generation_call.result` 和 `action=edit`。
- 退出路径：GatewayClient `editImages` Port 保持不变，可替换 Adapter；关闭 `imageEditing` 能力分组即可在渠道和 Runtime 前置禁用编辑。
- 维护责任：Runtime/GatewayClient 维护者负责 Adapter、资产和回归；模型网关维护者负责上游账号、别名与零重试配置。

## 验收与完成报告

- 验证证据：官方文档核对、Responses 文本/图片工具对照 PoC、Gateway 请求/响应 fake、连续两轮资产回归、上游拒绝的操作级安全错误、2026-08-15 当前配置两轮真实编辑 smoke、`tool_choice` / `max_tool_calls` 三组兼容对照、HTTP/SSE 与 Demo 构建。
- 剩余边界：内容审核、成本、质量与异常矩阵、遮罩、正式对象存储，以及上游映射变更后的重复 smoke。
- 文档与契约：同步 OpenSpec、README、场景链、AI SDK 对齐和决策索引。
- 重评条件：LiteLLM 原生/AI SDK openai-compatible 增加等价 Responses Adapter；真实上游持续不兼容；需要 provider 会话续接、遮罩或多图编辑。

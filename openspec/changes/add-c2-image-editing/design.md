## Context

既有 `image.generate` 已复用 Conversation Run、GatewayClient、AI SDK、LiteLLM、ImageAssetStore 和 `image_asset` 结果交付，但它只接受文本提示词。浏览器聊天附件仍使用 URL/data URL 兼容链，不具备稳定资产身份，也不适合作为会产生费用和新图片副作用的编辑输入。

锁定依赖 `ai@7.0.37` 与 `@ai-sdk/openai-compatible@3.0.14` 只覆盖 Image API 图片编辑；2026-08-01 上游连续三次拒绝 `/images/edits`。官方 Responses 图片工具支持图片上下文、`action=edit` 和多轮迭代，且 LiteLLM 已能代理 `/v1/responses`。锁定 SDK 暂无对应 openai-compatible Adapter，因此由 GatewayClient 内最小 HTTP Adapter 补齐协议，不改变 Runtime Port 和 LiteLLM key 边界。

## Goals / Non-Goals

**Goals:**

- 在同一 Conversation Run 事实模型内增加显式 `image.edit`。
- 只让当前会话拥有的受控 `image_asset` 进入图片模型调用。
- 源资产不可变，编辑输出创建新的资产事实并保留来源引用。
- 继承文生图的幂等、取消、单次尝试、资产落存和 SSE 交付语义。
- 复用官方 Responses 协议和 LiteLLM，由 GatewayClient 内受控 Adapter 补齐锁定 SDK 缺口，不形成 provider 直连。

**Non-Goals:**

- 首期不支持遮罩、局部重绘、多图融合、风格训练、批量离线编辑或完整版本树 UI。
- 不允许远程图片 URL 直接进入受控编辑链；远程导入需完成 SSRF、重定向和下载上限治理后另行规格化。
- 不把本地文件 Adapter、单模型 fake 回归或单次真实调用表述为生产可用。
- 不新增 provider 专属参数透传、真实模型名或浏览器模型密钥。

## Decisions

### 1. 使用独立 `image.edit` 操作

`image.generate` 保持纯文本输入；`image.edit` 要求非空 `message`、一条 `references: [{ type: "image_asset", assetId }]` 和可选白名单 `imageOptions`。独立判别保证错误、成本、模型能力和结果来源可稳定审计。

### 2. 上传先形成资产，再创建编辑 Run

浏览器把本地图片以受控 MIME 的原始二进制提交到会话资产入口。Runtime 校验字节上限、真实格式和尺寸，ImageAssetStore 原子写入二进制，SQLite 再登记 `source=uploaded` 元数据。登记失败时清理尚未成为事实的文件。

上传资产的 `runId` 为空；生成或编辑产物继续绑定创建它们的 Run。所有资产 ID 仍按 Conversation 校验，缺失、过期和跨会话访问统一返回不泄漏信息的 404。

### 3. Runtime 解析二进制，GatewayClient 只接收规范化图片

Runtime 在模型调用前从 SQLite 解析源资产及内部 storageKey，再由 ImageAssetStore 读取字节。GatewayClient `editImages` 只接收已校验的 `{ bytes, mediaType }`，由 Responses Adapter 在单次请求局部编码为 `input_image` data URL，用 `tool_choice` 强制选择 `image_generation` 并固定 `action=edit`。图片二进制不进入 Run JSON、Message、普通日志或 Trace。

### 4. 复用图片副作用边界

图片编辑与文生图共用单次模型尝试、绝对截止时间、取消、结果校验、临时文件清理和 `completeImageRun` 事务。Runtime 与 GatewayClient 的尝试预算不足以约束模型网关，因此承载图片副作用的别名同时固定 `num_retries: 0`，防止 LiteLLM 在不确定失败后重复请求。编辑输出使用 `source=edited`，源资产保持不变；用户消息中的 `image_asset` 引用构成最小来源链。

### 5. 渠道只上传本地图片

Demo 的“图生图”模式要求一张本地图片。提交时先调用受控上传入口，成功后再用稳定 assetId 创建 Run。上传失败不创建 Run；Run 失败不删除仍可复用的源资产。

### 6. 每轮输出成为下一轮可选源图

成功编辑产生的助手 `image_asset` 可以直接成为下一轮唯一源图。渠道成功后原子替换当前编辑附件，并在历史图片操作中提供“继续编辑”；下一轮创建全新普通 Run，不设置 `sourceRunId` 或 `recoveryMode`。每轮都重新发送本地当前资产，首期不持久化 provider response ID，也不依赖上游会话保留。

## Risks / Trade-offs

- [LiteLLM 或真实上游不开放 Responses 图片工具] -> 2026-08-02 图片工具 PoC 曾被拒绝，2026-08-15 当前配置已通过两轮真实编辑；上游映射或 key 变化后必须重复 smoke，生产声明仍需异常与质量矩阵。
- [上传后未提交 Run 形成孤立资产] -> 当前开发切片保留会话级资产，正式生命周期任务需按保留期清理未引用上传。
- [基础头部校验不能替代完整解码与恶意文件扫描] -> 保持开发边界，生产接入前引入成熟 MediaGuard/扫描 Adapter。
- [源图导致内存峰值] -> 首期固定单图、5 MiB 上传上限，Runtime 只在当前 Run 内读取字节。

## Migration Plan

1. 让 `image_assets.run_id` 可空，并迁移既有生成资产与消息关联。
2. 增加上传 Runtime/HTTP Adapter 和跨会话权限回归。
3. 增加 `image.edit` 输入、GatewayClient Responses 映射和 Runtime 结果事务。
4. 增加 Demo 图生图模式、上传准备、源图展示和上一版本继续编辑。
5. 完成 fake 协议、Runtime、HTTP、构建与真实两轮编辑 smoke；OpenSpec CLI 验证在工具可用前保持显式 TODO。

回滚时关闭上传 POST 和 `image.edit` 操作；已有上传/编辑资产保持只读访问，不改写既有 Conversation、Message 或 Run。

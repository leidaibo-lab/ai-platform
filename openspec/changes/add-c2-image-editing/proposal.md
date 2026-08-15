## Why

当前 C2 已能通过 `image.generate` 把文本提示词转换为新的 `image_asset`，但生成链明确拒绝图片输入。用户无法把已有图片作为受控事实提交给模型进行整体风格、构图或内容转换，也无法用同一 Conversation Run、幂等、取消和资产交付语义管理图生图任务。

既有 AI SDK `/images/edits` 路径已完成协议回归，但 2026-08-01 上游账号池连续三次拒绝真实编辑；OpenAI 官方文档同时明确建议会话式、可连续编辑的图片体验使用 Responses API 图片工具。平台应保留受控上传、资产所有权、Runtime 操作和结果治理，只在 GatewayClient 内适配锁定 SDK 尚未覆盖的 Responses 图片编辑协议。

## What Changes

- 新增显式 `operation=image.edit`，输入为非空文本指令、一张当前会话可访问的 `image_asset` 引用和平台白名单图片选项。
- 新增 `POST /api/runtime/conversations/{conversationId}/image-assets` 受控二进制上传入口；SQLite 只保存元数据，ImageAssetStore 保存图片二进制。
- GatewayClient 保持独立图片编辑方法，内部改用受控 Responses Adapter，经 LiteLLM `/v1/responses` 调用 `image_generation.action=edit`。
- 编辑结果创建新的 `image_asset`，源资产保持不可变；用户消息保存源资产引用，输出消息和 Run 保存新资产引用。
- 编辑成功后渠道把输出资产设为下一轮当前源图，也允许从历史图片结果显式选择“继续编辑”。
- 图生图继承 requestId 幂等、单次模型尝试、绝对截止时间、取消、错误脱敏和 SSE `artifact-created` 交付。
- Demo 增加“图生图”模式，要求一张本地图片和非空编辑指令；浏览器先上传受控资产，再提交只含稳定资产 ID 的 Run。

## Capabilities

### New Capabilities

无。图片编辑仍属于 `ai-platform` 内部 C2 图片能力域，不提前拆分独立服务。

### Modified Capabilities

- `ai-platform`: 扩展 Conversation Run、分类型引用、图片资产上传和模型网关图片调用契约，增加 C2 `image.edit`。

## Impact

- Agent Runtime：新增编辑输入校验、源资产解析、二进制读取和图片编辑执行分支。
- 存储：允许无 Run 的上传资产，并保持生成/编辑产物与 Run 的关联。
- GatewayClient / LiteLLM：新增 Responses 图片工具 Adapter，并拆分图片生成与编辑默认模型，不改变密钥边界。
- 渠道：在图生图模式和上传准备阶段上增加稳定资产的多轮承接。
- 治理：源图和提示词不得进入 Trace，真实上游兼容性、内容审核与成本仍需单独验收。

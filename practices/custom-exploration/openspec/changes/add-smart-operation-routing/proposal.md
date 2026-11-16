## Why

首版智能路由已经移除渠道发送前的“对话 / 生图 / 图生图”三选一，但 Router 只读取当前消息和当前附件。图片编辑完成后，视觉澄清或普通聊天会让 Composer 不再提交附件；后续“继续优化”“自己判断吧”“输出图片”等依赖前文的输入因此在业务模型调用前被固定为 `conversation.chat`。能看到历史的对话模型介入时已经无权切换 operation，最终只能报告没有图片编辑或导出工具。

Runtime 已拥有不可变 Message、真实 Run operation、受控 `image_asset`、幂等和会话版本事实。智能路由需要在这些事实之上读取有界 routing snapshot，让模型只表达结构化意图和可验证证据，由 Runtime 选择活动图片、组装输入并决定真实 operation；不能针对个别短语增加关键词特判，也不能把前端缓存提升为事实源。

## What Changes

- 活动图片从已提交 Message、真实 Run operation 与可用 `image_asset` 引用确定性推导；没有图片引用的聊天轮不清空活动图片，上传未发送、远程、多图、过期和跨会话资产不参与投影。
- Runtime 在分类前读取带会话版本、消息数量和单条正文字符上限的 routing snapshot；显式当前附件继续作为硬约束并覆盖历史活动图片。
- 无当前附件但有活动图片时，候选扩展为 `conversation.chat / image.generate / image.edit`；无活动图片时仅候选对话/生成；受限附件仍固定对话。
- 分类模型通过 AI SDK `Output.object` 只返回 `operation / confidence / useActiveImage / relevantMessageIds`。Runtime 校验证据和候选，选择实际源资产，并从不可变消息与当前输入组装业务 Prompt。
- 图片 operation 仍要求 `confidence >= 0.85`；非法证据、失效资产、低置信度、结构错误和非取消分类失败回退不继承历史图片的 `conversation.chat`，不产生图片副作用。
- Run 保存真实 operation、实际图片引用和版本化脱敏 `intentDecision`，不保存 provider 原始分类文本或隐藏推理；快照变化时禁止使用旧证据执行图片操作，幂等重放和恢复不重新分类。
- 自动模式拒绝浏览器模型选择，Runtime 按真实 operation 使用服务端默认别名。
- 增加独立意图路由双模式评测：确定性模式验证 Runtime/Store/资产链，真实模型模式只替换分类器并使用 fake 图片模型；两类结果分开报告。

## Capabilities

### New Capabilities

无。智能路由属于现有 Agent Runtime 的任务路由职责。

### Modified Capabilities

- `ai-platform`：扩展 Conversation Run operation、模型选择、附件引用、幂等和恢复契约。

## Impact

- Agent Runtime：Router 从只看当前输入升级为有界会话快照；新增活动图片投影、证据校验、源图选择、Prompt 组装和版本冲突保护。
- 存储：不新增可变 active image 事实源；Store 提供 routing snapshot，Run 原子保存真实 operation、实际引用和脱敏 intentDecision。
- GatewayClient：继续复用 AI SDK `Output.object`，结构化分类 schema 增加 `useActiveImage` 与 `relevantMessageIds`，业务图片 Port 不变。
- 渠道：普通输入仍只提交 `operation=auto`；刷新后可以展示服务端活动图片投影，但本地 Composer 不再决定图片继承。
- 模型网关：继续只接收服务端别名，不新增浏览器模型或 provider 参数。
- 评测：新增与天气 runtime scenario 分离的 `scenarios/runtime-routing/` 协议与 fixture，并由后续通用 Runner 分别执行确定性和真实模型模式；真实图片模型成功率与分类准确率保持隔离。

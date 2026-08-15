## Context

`conversation.chat`、`image.generate` 和 `image.edit` 已有不同输入、模型、费用和副作用语义。首版智能路由用当前附件收窄候选后调用结构化分类，但 operation 的选择发生在 Context Planner 之前；因此分类器看不到历史消息和上一轮图片结果。图片编辑得到 B 后，只要当前请求不再显式附带 B，依赖前文的“继续优化”就只能候选对话/生成。后续对话模型即使理解真实意图，也不能改变已经持久化的 operation 或调用独立图片 Port。

这要求 Runtime 在路由阶段拥有一个比业务 Context Manifest 更小、同步且可审计的 routing snapshot。快照不是长期记忆，也不是前端 Composer 状态；它从 Store 已提交事实投影，并只给分类器暴露作出 operation 判断所需的最少上下文。

## Goals / Non-Goals

**Goals:**

- 让普通发送默认使用 `operation=auto`，减少用户模式选择。
- 从不可变 Message、真实 Run operation 和受控资产派生活动图片，跨聊天轮和刷新保持一致。
- 用有界 routing snapshot 与 AI SDK `Output.object` 获得 `operation / confidence / useActiveImage / relevantMessageIds`。
- 让当前附件、候选矩阵、历史证据校验和 `0.85` 阈值阻止不确定图片副作用。
- 由 Runtime 选择真实源图、组装可追溯业务 Prompt，并保存真实 operation 与 intentDecision。
- 分开验证无模型确定性链路和真实模型语义识别质量。

**Non-Goals:**

- 不做多图编辑、远程图片编辑、遮罩、局部重绘或文档生图。
- 不让分类模型选择真实模型、provider 参数或图片选项。
- 不让分类模型选择 assetId、生成自由 Prompt 或获取图片二进制/完整会话。
- 不新增可变 active image 事实表，不把异步 Memory Manager 用作本轮路由依赖。
- 不建设通用工作流、模型路由产品或在线阈值学习。

## Decisions

### 1. Store 从不可变事实投影 routing snapshot

Runtime 在分类前从 Store 读取带会话版本的 `routing-context.v2` 快照。快照只包含 `committed` 近期消息的受限投影、消息 ID/顺序/角色、关联真实 Run operation，以及可空的活动图片元数据；`interrupted` 助手片段默认排除，HTTP(S) 和 data URL 在字符截断前替换为稳定占位符，SQLite 原始 Message 不被改写。当前请求作为独立、尚未提交的规范化输入加入分类。图片二进制、storageKey、provider 正文、附件地址和预算外完整历史不进入快照。

活动图片按消息顺序从已提交引用推导，不单独可写。资产必须属于当前会话、可用且未过期；助手图片只接受 completed 图片 Run 的产物，用户图片只接受消息中已持久化的唯一受控引用。没有图片引用的聊天轮会被扫描跳过，因此不会清空之前的图片；仅上传但未发送、远程、多图、过期和跨会话资产均不合格。该同步工作上下文不同于异步 Memory Manager：后者可最终一致地压缩长期事实，不得决定当前图片副作用。

### 2. 当前附件和活动图片共同形成候选

- 当前恰好一张受控 `image_asset` 且无其他附件：`conversation.chat | image.edit`；当前资产覆盖历史活动图片。
- 无当前附件但存在活动图片：`conversation.chat | image.generate | image.edit`。
- 无当前附件且无活动图片：`conversation.chat | image.generate`。
- 任意 `conversation_message` 引用、远程图片、文档、多图或未知引用：仅 `conversation.chat`，且不隐式继承活动图片。

附件类型、数量、所有权和状态均在模型分类前校验。候选只有对话时允许跳过分类；模型永远不能扩展候选或用历史图片替换当前显式图片。

### 3. 分类器只提出可验证的意图证据

GatewayClient 复用 AI SDK `Output.object`，分类器只返回：

```json
{
  "operation": "conversation.chat | image.generate | image.edit",
  "confidence": 0.0,
  "useActiveImage": false,
  "relevantMessageIds": ["message-id"]
}
```

Runtime 验证 operation 属于候选，证据 ID 属于当前快照、顺序有效且数量受限。分类器不得返回 assetId、模型、尺寸、provider 参数、完整 Prompt 或历史正文。当前输入由 Runtime 必然加入业务 Prompt；视觉问题本身自包含时证据数组可以为空，无当前附件的隐式编辑必须提供至少一条有效历史消息。需要继承历史编辑要求时，只从通过验证的消息 ID 读取不可变正文并按原顺序组装。

图片 operation 继续要求 `confidence >= 0.85`。无当前显式图片的 `image.edit` 还要求 `useActiveImage=true`、活动图片有效且至少一条历史消息证据通过校验；`image.generate` 不得继承活动图片。对话只有在 `useActiveImage=true` 且所有已声明证据通过校验时才把活动图片作为受控视觉输入，否则作为普通文本对话。非法证据、越权候选、低置信度、结构失败、非取消分类失败或子截止时间不足均回退不携带历史图片的对话。

### 4. 分类与业务执行保持副作用隔离

分类阶段不创建图片资产，也不持有图片副作用 Lease。分类子截止时间耗尽或其他非取消失败不是图片 Run 失败，而是安全回退；渠道在收到 `run-started` 前通过 `conversationId + requestId` 显式取消时，Demo Server 从进程内活动请求注册表向 Runtime 传播 AbortSignal，不创建 Run，也不继续业务模型。普通 SSE 断线不触发该控制器。Runtime 完成校验后选择显式资产或活动图片、组装真实输入并创建 Run；图片调用只能在 ExecutionPolicy 允许且取得有效 Lease 后发生，调用前再次读取和校验源图。

自动请求不接受 `model`，业务分支按真实 operation 使用服务端默认别名。视觉聊天使用对话模型的受控图片输入，不把图片编辑伪装成聊天工具；图片生成/编辑继续调用独立 GatewayClient Port。

### 5. intentDecision 与真实引用共同形成审计事实

数据库不保存 `auto` 作为执行 operation。Run 保存版本化、脱敏的 intentDecision：schema/router/context strategy 版本、解析与分类 operation、confidence/threshold、决策来源、候选、useActiveImage、校验后的 relevantMessageIds、context version 和截断标记；实际 assetId 通过当前 Message/Run 的受控图片引用保存。provider 原始分类文本、隐藏推理、图片内容和完整历史正文均不进入该事实。

相同 requestId 重放直接使用既有 Run 的 operation、引用和 intentDecision。显式历史图片“继续编辑”使用当前选择的 `image.edit`；`retry / regenerate / continue` 继承来源 Run operation，均不重新分类。分类后若会话版本已变化，不得使用旧证据或旧源图执行图片操作；Store 首次冲突使用内部 `routing_context_stale` 触发一次重路由，第二次冲突由 Runtime 转换为公开 `routing_context_changed`。

### 6. 双模式评测隔离链路正确性与模型质量

新增独立 `scenarios/runtime-routing/` 协议，避免把图片语义识别塞入当前受天气恢复边界约束的 `scenarios/runtime/`：

- deterministic：fixture 提供分类结果，图片 Gateway 使用 fake；直接断言 snapshot、证据、实际源图字节、视觉图片输入、编辑 Prompt 历史、Message/Run/intentDecision、幂等、刷新恢复和失败图片调用副作用。
- real-model：经现有 GatewayClient/LiteLLM 调用固定分类模型，图片 Gateway 仍用 fake；只测模型是否正确选择 operation、活动图片和证据，避免真实图片费用/失败污染分类指标。

fixture 与标准答案和 Runner 分离，固定模型别名、实际模型、Prompt/schema、采样参数和 fixture 版本。Runner 从固定业务 Gateway 的实际调用参数读取源图指纹、视觉 data URL、编辑 Prompt 和失败图片调用；报告 operation、错误图片副作用、源资产引用/字节、视觉输入、编辑 Prompt 历史、活动图片、证据、token、平均延迟与 P95。通过动态 schema 校验的真实分类样本少于 30 时只标记 observation-only，未调用分类器的轮次不计入样本门槛。

## Risks / Trade-offs

- routing snapshot 增加分类 token 和首包延迟：固定消息数量与单条正文字符上限、记录截断和实际 token，不能无界发送完整会话。
- 有界窗口可能遗漏很早的编辑意图：通过版本化 fixture 校准窗口；不能以关键词特判或异步长期记忆掩盖。
- 高置信度可能误判：附件硬约束、候选钳制、证据验证、`0.85` 阈值、图片单次尝试和独立真实模型评测共同限制影响。
- 派生投影每次读取有查询成本：先保持只读派生；只有测得成为瓶颈时再评估带版本的物化投影，不能提前增加双写事实。
- 自动请求不能自选模型：这是为了防止先选模型再反向影响 operation；显式 operation 的既有兼容能力不在本 change 中删除。

## Migration Plan

1. 以 2026-08-15 决策替代首版当前附件路由记录，更新 delta/stable 契约。
2. 增加 Store routing snapshot、活动图片投影和会话版本校验，不引入可变 active image 字段。
3. 扩展分类 Port/schema、Runtime 证据校验、源图选择、Prompt 组装和 intentDecision 持久化。
4. 让会话读取返回服务端工作上下文投影，渠道只负责展示；普通发送仍提交 auto。
5. 建立 intent-routing 确定性/真实模型双模式场景，先通过确定性链路，再报告真实模型小样本观察和发布规模指标。

回滚时可关闭上下文分类并恢复首版当前附件路由或显式 operation；已有 Run 无需迁移，因为持久化值始终是真实 operation，旧 Run 没有 intentDecision 时按兼容缺省读取。

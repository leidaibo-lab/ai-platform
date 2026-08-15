## ADDED Requirements

### Requirement: Runtime smart operation routing

系统 SHALL 允许渠道为普通新 Run 提交 `operation=auto`，并由 Agent Runtime 根据当前输入和有界会话 routing snapshot 解析、校验和持久化真实 operation；分类模型不得直接拥有图片副作用、源资产选择、模型选择、Prompt 组装或附件判定权。

#### Scenario: Browser delegates ordinary routing to Runtime

- **WHEN** 用户在 Demo 普通输入区提交正文、附件或消息引用
- **THEN** Demo SHALL NOT 要求用户选择“对话 / 生图 / 图生图”模式或模型别名
- **AND** Demo SHALL 提交 `operation=auto` 且不提交 `model`，由 Runtime 解析真实 operation
- **AND** 只有历史图片“继续编辑”和 `retry / regenerate / continue` 恢复入口 SHALL 提交已经确定的显式 operation

#### Scenario: Runtime builds a bounded routing snapshot

- **GIVEN** 当前 Conversation 存在已提交的 Message、Run 和 `image_asset` 事实
- **WHEN** Runtime 解析一个普通 auto 请求
- **THEN** Runtime SHALL 读取带会话版本的有界 routing snapshot，并把当前规范化输入与快照分开
- **AND** `routing-context.v2` 快照 SHALL 只包含 `committed` 消息，并排除默认不可信的 `interrupted` 助手片段
- **AND** 快照 SHALL 只包含策略允许消息数量与单条正文字符上限内的近期消息投影、关联真实 Run operation、稳定 messageId 和可空活动图片投影
- **AND** 历史正文投影 SHALL 在字符截断前把 HTTP(S) 与 data URL 替换为稳定占位符，且不得改写 SQLite 中的原始 Message 事实
- **AND** 快照 SHALL NOT 包含图片二进制、storageKey、provider 原始正文、受控读取 URL 或预算外完整会话
- **AND** Runtime SHALL NOT 使用异步 Memory Manager 或渠道本地状态决定本轮活动图片和 operation

#### Scenario: Runtime derives the active image from committed facts

- **WHEN** Runtime 构造 routing snapshot 的活动图片投影
- **THEN** Runtime SHALL 按已提交消息顺序从 Message、真实 Run operation 和 `image_asset` 引用推导最近的合格图片
- **AND** 资产 SHALL 属于当前会话、状态可用且未过期；助手图片 SHALL 来自 completed `image.generate` 或 `image.edit` Run，用户图片 SHALL 是该消息已持久化的唯一受控引用
- **AND** 没有图片引用的普通聊天 SHALL NOT 清空此前可推导的活动图片
- **AND** 仅上传但尚未进入消息的图片、远程 URL、多图、过期资产和跨会话资产 SHALL NOT 成为活动图片

#### Scenario: Runtime derives candidates from current facts and active image

- **GIVEN** Runtime 已校验当前输入、附件类型、数量、会话所有权和资产状态
- **WHEN** auto Run 恰好包含一张当前会话可读取的显式 `image_asset` 且没有其他附件
- **THEN** 允许候选 SHALL 仅为 `conversation.chat` 与 `image.edit`
- **AND** 显式当前图片 SHALL 覆盖历史活动图片，模型不得选择另一 assetId
- **WHEN** auto Run 不包含当前附件或引用但存在可用活动图片
- **THEN** 允许候选 SHALL 仅为 `conversation.chat`、`image.generate` 与 `image.edit`
- **WHEN** auto Run 不包含当前附件或引用且不存在可用活动图片
- **THEN** 允许候选 SHALL 仅为 `conversation.chat` 与 `image.generate`
- **WHEN** auto Run 包含任意 `conversation_message` 引用、远程图片 URL、文档链接或多张图片
- **THEN** Runtime SHALL 将真实 operation 固定为 `conversation.chat`，不得执行图片生成或编辑
- **AND** Runtime SHALL NOT 为该受限输入隐式继承历史活动图片

#### Scenario: Runtime classifies against validated context and evidence

- **GIVEN** 当前候选集包含至少两个 operation
- **WHEN** Runtime 解析 auto Run
- **THEN** Runtime SHALL 通过 GatewayClient 使用 AI SDK `Output.object` 请求且只接受 `operation`、`0..1 confidence`、布尔值 `useActiveImage` 和 `relevantMessageIds` 的结构化结果
- **AND** 分类模型 SHALL NOT 返回或选择 assetId、模型、尺寸、provider 参数、完整 Prompt 或历史消息正文
- **AND** Runtime SHALL 验证 operation 属于当前候选，并验证 `relevantMessageIds` 只指向当前快照内、顺序有效且数量受限的真实消息
- **AND** 视觉问题的当前输入已经自包含完整意图时 `relevantMessageIds` MAY 为空；无当前显式图片的 `image.edit` SHALL 至少包含一条通过校验的历史消息
- **AND** 只有候选中的 `image.generate` 或 `image.edit` 且 `confidence >= 0.85` 时，Runtime MAY 解析为对应图片 operation
- **AND** 无当前显式图片的 `image.edit` SHALL 额外要求 `useActiveImage=true`、可用活动图片和至少一条有效历史消息；`image.generate` SHALL NOT 继承活动图片
- **AND** 候选越权、低置信度、结构不合法、非法证据、活动图片失效、非取消分类失败或剩余截止时间不足 SHALL 安全回退为不继承历史图片的 `conversation.chat`
- **AND** 安全回退 SHALL NOT 创建图片资产、调用图片模型或把同一 Run 作为失败图片 Run 收口
- **AND** 调用方在分类完成前中止请求时 Runtime SHALL 停止分类，不得继续发起对话或图片模型调用，也不得创建或伪造 `cancelled` Run

#### Scenario: Channel explicitly cancels routing by request identity

- **GIVEN** 渠道已经提交带 `requestId` 的 auto 请求但尚未收到 `run-started`
- **WHEN** 渠道请求 `POST /api/runtime/conversations/{conversationId}/run-requests/{requestId}/cancel`
- **THEN** Demo Server SHALL 将显式请求级取消信号传给 Runtime，且普通 SSE 断线 SHALL NOT 触发该信号
- **AND** 取消发生在 Run 创建前时渠道流 SHALL 返回 `cancelled`、`run=null` 与 `assistantMessage=null`
- **AND** Runtime SHALL NOT 创建消息、Run 或图片资产，也不得继续调用业务对话或图片模型

#### Scenario: Visual chat inherits the active image only when supported

- **GIVEN** auto 请求没有当前附件但 routing snapshot 存在活动图片
- **WHEN** 分类结果为 `conversation.chat`、`useActiveImage=true` 且所有已声明证据通过 Runtime 校验
- **THEN** Runtime SHALL 把服务端选择的活动图片作为受控视觉输入交给能力兼容的对话模型
- **AND** 实际图片引用 SHALL 进入当前 Message/Run 事实，刷新与重放不得依赖前端附件缓存
- **WHEN** `useActiveImage=false`、证据无效或当前输入被附件矩阵固定为对话
- **THEN** Runtime SHALL 执行不携带历史活动图片的普通对话

#### Scenario: Runtime assembles an implicit image edit from immutable evidence

- **GIVEN** auto 请求没有当前附件，分类结果合法选择 `image.edit`
- **WHEN** Runtime 准备业务模型输入
- **THEN** Runtime SHALL 自行选择 snapshot 中已校验的活动图片作为唯一源资产
- **AND** Runtime SHALL 始终包含当前输入，并只从校验通过的 `relevantMessageIds` 对应消息按原顺序组装历史编辑要求
- **AND** Runtime SHALL NOT 使用分类模型自由生成的替代编辑 Prompt
- **AND** 图片调用前 SHALL 再次校验源资产所有权、状态、类型和字节

#### Scenario: Runtime persists a sanitized intent decision

- **WHEN** Runtime 完成 auto 解析并准备执行业务分支
- **THEN** Runtime SHALL 在 Run 事实中保存 `conversation.chat`、`image.generate` 或 `image.edit` 的真实 operation，不得把 `auto` 保存为执行 operation
- **AND** Run SHALL 持久化版本化、脱敏的 `intentDecision`，至少记录 schema/router/context strategy 版本、解析与分类 operation、confidence/threshold、决策来源、候选、`useActiveImage`、校验后的 `relevantMessageIds`、context version 和截断标记
- **AND** 实际 assetId SHALL 通过受控 Message/Run 图片引用持久化，不得来自分类模型输出
- **AND** Runtime SHALL NOT 在 Message、Run JSON、普通日志、Trace 或 intentDecision 中持久化 provider 原始分类文本、隐藏推理、图片内容或完整历史正文
- **AND** 后续模型能力校验、默认别名选择、结果类型、错误语义和重放 SHALL 以真实 operation 为准
- **AND** ExecutionPolicy SHALL 在解析完成后评估真实 operation，不得把入口 `auto` 作为可执行或可持久化操作

#### Scenario: Routing snapshot changes before Run creation

- **GIVEN** Runtime 已基于一个 routing snapshot 完成分类
- **WHEN** Run 创建前当前会话版本已变化
- **THEN** Runtime SHALL NOT 使用过期证据或源资产执行图片 operation
- **AND** Runtime MAY 在有界次数内重新读取和分类；持续冲突 SHALL 返回稳定 `routing_context_changed`

#### Scenario: Auto routing selects a server-side default model

- **WHEN** 渠道提交 `operation=auto`
- **THEN** 渠道 SHALL NOT 提交 `model`，Runtime SHALL 拒绝携带浏览器模型别名的 auto 请求
- **AND** Runtime SHALL 根据真实 operation 使用服务端 `defaultModels` 中对应且当前网关可见、能力兼容的平台别名
- **AND** 分类模型和浏览器 SHALL NOT 选择真实上游模型、provider 参数或图片选项

#### Scenario: Explicit continuation bypasses classification

- **GIVEN** 用户从历史图片显式选择“继续编辑”，或通过 `retry`、`regenerate`、`continue` 从一个既有 Run 发起恢复
- **WHEN** Runtime 创建具有新幂等标识的 Run
- **THEN** 历史图片继续编辑 SHALL 使用显式 `image.edit` 和选定的唯一源资产
- **AND** 恢复 Run SHALL 继承来源 Run 已持久化的真实 operation
- **AND** Runtime SHALL NOT 再次执行意图分类，也不得允许渠道把恢复 operation 改成其他值

#### Scenario: Completed auto request is replayed

- **WHEN** 渠道使用相同 requestId 重放一个已经解析或完成的 auto 请求
- **THEN** Runtime SHALL 返回或继续既有 Run 及其已持久化真实 operation、图片引用和 intentDecision
- **AND** Runtime SHALL NOT 重新分类、切换 operation、重复调用图片模型或创建重复资产

#### Scenario: Routing evaluation separates deterministic and real-model evidence

- **WHEN** 平台验收会话上下文感知的 operation 路由
- **THEN** 确定性模式 SHALL 使用 fixture 驱动分类器和 fake 图片模型验证 snapshot、证据、源资产引用与实际字节、视觉输入、编辑 Prompt 历史、持久化、幂等与零错误图片副作用
- **AND** 真实模型模式 SHALL 固定模型别名、实际模型、Prompt/schema、采样参数和 fixture 版本，只替换分类器并继续使用 fake 图片模型
- **AND** Runner SHALL 根据业务 Gateway 的实际调用参数和失败调用计数判定源图、视觉输入、Prompt 与图片副作用，不得只根据最终持久化引用或产物推断
- **AND** 报告 SHALL 分开给出 operation、错误图片副作用、源资产引用/字节、视觉输入、编辑 Prompt 历史、活动图片包含、证据、token、平均延迟和 P95
- **AND** 通过动态 schema 校验的真实分类样本少于 30 时 SHALL 标记 `observation-only`，不得把未调用分类器的轮次、确定性通过率或小样本百分比表述为真实模型发布准确率

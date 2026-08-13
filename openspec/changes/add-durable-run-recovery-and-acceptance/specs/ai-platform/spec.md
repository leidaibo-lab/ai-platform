## MODIFIED Requirements

### Requirement: Runtime conversation lifecycle

Demo Server SHALL 提供由 Agent Runtime 拥有的会话资源，浏览器不得把本地历史或摘要作为会话事实源。

#### Scenario: User creates and resumes conversations

- **GIVEN** Demo Server 已启动
- **WHEN** 浏览器请求 `POST /api/runtime/conversations`
- **THEN** Runtime SHALL 创建持久化会话并返回 `conversationId`
- **WHEN** 浏览器请求 `GET /api/runtime/conversations` 或 `GET /api/runtime/conversations/{conversationId}`
- **THEN** Runtime SHALL 返回会话列表或完整消息、结构化记忆和版本状态
- **AND** 会话详情 SHALL 通过 `lastRun` 保留最近完成结果，并通过 `latestRun` 暴露最近运行中、完成、取消或失败 Run 的状态与韧性证据

#### Scenario: User closes a conversation

- **GIVEN** 会话状态为 `active`
- **WHEN** 浏览器请求 `POST /api/runtime/conversations/{conversationId}/close`
- **THEN** Runtime SHALL 完成最终记忆 checkpoint 并将会话标记为 `closed`
- **AND** 关闭后的会话 SHALL 拒绝新的 Run

#### Scenario: User organizes conversation history

- **GIVEN** 会话由 Runtime 持久化且当前没有活动 Run
- **WHEN** 浏览器通过 `PATCH /api/runtime/conversations/{conversationId}` 提交非空 `title` 或布尔值 `archived`
- **THEN** Runtime SHALL 原子更新会话标题或独立的归档时间并增加会话版本
- **AND** 归档 SHALL NOT 删除 Conversation、Message、Run、Memory 或事件事实
- **AND** 取消归档 SHALL NOT 把 `closed` 会话重新改为 `active`
- **AND** 搜索、时间分组和归档筛选 MAY 由渠道基于服务端会话摘要完成，不得成为第二份会话事实

#### Scenario: Browser preserves a channel-local draft across refresh

- **GIVEN** 用户在当前浏览器标签页中有尚未发送的正文、链接附件、消息引用或模型选择
- **WHEN** 页面刷新或在会话之间切换
- **THEN** 渠道 MAY 在 session 范围恢复草稿
- **AND** 渠道草稿 SHALL NOT 作为 Conversation、Message 或 Run 事实提交给其他客户端
- **AND** 本地图片 data URL SHALL NOT 写入 session 持久化草稿

#### Scenario: Channel inspects a completed or rejected Run

- **GIVEN** Run 已经过系统结果验收
- **WHEN** 渠道读取 Run 结果或会话 `latestRun`
- **THEN** Runtime SHALL 返回可空 `acceptance` 事实
- **AND** 该事实 SHALL 区分 `accepted` 与 `rejected`，并提供稳定策略、版本、原因码和证据摘要
- **AND** 普通对话尚未配置独立验收策略时 SHALL 保持 `acceptance=null`，不得伪装为系统已验收

### Requirement: V1 read-only tool loop

Agent Runtime SHALL 通过 GatewayClient 复用 AI SDK `ToolLoopAgent` 执行纯文本有界只读工具循环，并只在动态结构化输出等特殊调用中使用带 `tools`、`stopWhen` 和 `prepareStep` 的 Core 函数路径；Runtime 继续拥有 Conversation、Run、权限、工具事实、幂等、交付、验收和审计，LiteLLM SHALL 只负责模型访问、路由和转发，不得执行或保存业务工具结果。

#### Scenario: Runtime routes current weather to a governed tool

- **GIVEN** `get_weather` 已在服务端 Tool Registry 中启用
- **WHEN** 当前输入包含明确地点且属于今天或明天的天气查询
- **THEN** Runtime SHALL 通过服务端确定性路由只向模型开放 `get_weather`
- **AND** Runtime SHALL 通过 `ToolLoopAgent.prepareStep` 把首步固定路由到 `get_weather`，ToolResult 回填后的后续步骤仅在该受限工具集合内恢复自动选择
- **AND** Runtime SHALL 在同一 Run 总截止时间内执行固定目标的 Open-Meteo Connector
- **AND** Runtime SHALL 持久化 `toolCallId`、工具名、脱敏输入、状态、结构化结果或安全错误、来源和数据时间
- **AND** Runtime SHALL 将结构化 ToolResult 回填给同一有界生成循环，由模型生成最终候选回答
- **AND** 实时天气结果 SHALL NOT 自动写入长期结构化记忆

#### Scenario: Input does not match a governed tool route

- **GIVEN** Tool Registry 中存在一个或多个受管工具
- **WHEN** 当前输入未命中 Runtime 的确定性工具路由
- **THEN** Runtime SHALL NOT 向模型传入 ToolSet、`toolsContext` 或必需工具名
- **AND** 模型 SHALL NOT 仅凭 Prompt 或自身声明获得 Connector 执行权限
- **AND** 普通回答 SHALL 保持 `acceptance=null`，除非另有独立验收策略明确适用

#### Scenario: Weather route produces no required ToolResult

- **GIVEN** 当前输入已命中 `get_weather` 确定性路由
- **WHEN** 模型返回候选正文但 Run 没有持久化对应的 ToolResult
- **THEN** Runtime SHALL 记录 rejected AcceptanceResult 并把 Run 收口为 `failed`
- **AND** Runtime SHALL NOT 把模型对天气或工具执行的声明当作完成证据
- **AND** Runtime SHALL NOT 持久化或向渠道交付该候选正文

#### Scenario: Browser observes a tool stage

- **GIVEN** 流式 Run 已通过 `run-started` 返回稳定 `runId`
- **WHEN** Runtime 开始、完成或失败一个工具调用
- **THEN** 当前 POST SSE SHALL 分别发送 `tool-started`、`tool-completed` 或 `tool-failed`
- **AND** 事件 SHALL 只包含工具调用 ID、工具名、公开标题、状态、来源和数据时间等安全元数据
- **AND** 渠道 SHALL 根据真实服务端事件展示工具阶段，不得自行猜测或伪造工具执行

#### Scenario: Tool execution fails safely

- **GIVEN** 天气地点不存在、工具输入无效、Connector 超时或上游不可用
- **WHEN** 工具无法返回成功结果
- **THEN** Runtime SHALL 将工具调用收口为 `failed` 并保存稳定错误码、公开说明和可重试性
- **AND** Runtime SHALL 将安全失败结果回填给模型以生成可执行说明，不得暴露原始响应正文、调用栈或任意外部 URL
- **AND** 一个工具失败 SHALL NOT 自动改写为模型服务失败

#### Scenario: Tool loop is bounded and replayable

- **GIVEN** 同一 Run 可能产生多步模型与工具交互
- **WHEN** Runtime 执行工具循环
- **THEN** 循环 SHALL 共享 Run 截止时间并最多执行四个模型步骤
- **AND** 只允许当前 Run 经确定性路由开放的 Tool Registry 只读工具，不得让模型提交任意 URL 或动态代码
- **AND** 相同 `requestId` 的已完成 Run 重放 SHALL 返回已持久化工具事实、验收事实和回答，不得再次调用 Connector

#### Scenario: Model fails after tool execution starts

- **GIVEN** 模型已在当前 Run 中生成工具调用
- **WHEN** Runtime 开始执行 Connector，但后续模型步骤返回可重试的瞬时错误
- **THEN** Runtime SHALL 在 Connector 执行前越过当前生成尝试的自动重试边界
- **AND** Runtime SHALL NOT 为该错误重新执行整段模型与工具循环
- **AND** 已开始的工具调用 SHALL 保持其已持久化的 ToolResult 状态
- **AND** 如果需要验收的候选尚未向渠道交付且 SQLite 中至少存在一个 completed ToolResult，Runtime SHALL 从会话事实源重新读取结果，并发起一个不携带 ToolSet、`toolsContext` 或强制工具路由的总结恢复阶段
- **AND** 恢复消息 SHALL 使用匹配 `toolCallId` 和工具名的 AI SDK 结构化 `tool-call` / `tool-result` ModelMessage，不得通过普通文本 Prompt 冒充工具结果
- **AND** 恢复阶段 SHALL 共享原 Run 的绝对截止时间、取消信号、模型别名、业务 Trace 和幂等边界，且不得再次执行 Connector
- **AND** 恢复成功并通过系统验收后原 Run SHALL 进入 `completed`，并且 Runtime SHALL 只持久化一条完整助手消息

#### Scenario: ToolResult summary recovery cannot complete

- **GIVEN** Runtime 已因工具后模型瞬时错误进入无工具总结恢复阶段
- **WHEN** 恢复调用再次失败、被取消或耗尽原 Run 剩余时限
- **THEN** Runtime SHALL NOT 再次执行 Connector
- **AND** 非取消失败 SHALL 使原 Run 进入 `failed`，并在 resilience 中分别保留原生成失败和恢复执行证据
- **AND** 调用方取消 SHALL 继续遵守独立 `cancelled` 状态和部分正文持久化契约
- **AND** 如果普通回答已经交付正文，或不存在 completed ToolResult，Runtime SHALL NOT 自动恢复，Run SHALL 按既有失败语义收口

#### Scenario: Runtime restarts after a read-only ToolResult was committed

- **GIVEN** 一个 `conversation.chat` Run 仍为 `running`
- **AND** Run 已持久化原绝对截止时间、ChainTrace ID 和原用户消息
- **AND** Run 的全部工具调用都是已完成、已注册的只读工具并具有结构化 ToolResult
- **AND** Run 尚未持久化助手消息且原截止时间仍有剩余
- **WHEN** Runtime 进程重新启动并扫描遗留 Run
- **THEN** Runtime SHALL 从 SQLite 重新读取会话事实和 completed ToolResult
- **AND** Runtime SHALL 使用匹配调用 ID 的结构化工具消息发起无 ToolSet 的最终总结恢复
- **AND** Runtime SHALL NOT 再次执行 Connector
- **AND** 恢复 SHALL 继续使用原 Run、requestId、模型别名、ChainTrace ID 和绝对截止时间
- **AND** 系统验收通过后原 Run SHALL 完成，不得创建第二条用户消息或第二个 Run

#### Scenario: Interrupted Run has no safe recovery point

- **GIVEN** 遗留 Run 是图片生成、写操作、无 completed ToolResult、包含 running/failed/未知工具调用，或原绝对截止时间已经耗尽
- **WHEN** Runtime 执行启动恢复扫描
- **THEN** Runtime SHALL NOT 重放模型工具循环、Connector 或图片模型
- **AND** Runtime SHALL 把 Run 收口为带稳定恢复错误码的 `failed`
- **AND** 已持久化的用户消息、工具事实和资产事实 SHALL 保持不变

#### Scenario: Weather candidate passes independent acceptance

- **GIVEN** `get_weather` 已返回持久化 `weather.v1` ToolResult
- **WHEN** 模型返回最终候选正文
- **THEN** Runtime SHALL 独立检查正文包含匹配的地点、数据时间、来源和至少一个 ToolResult 事实值
- **AND** 验收规则 SHALL NOT 依赖模型声明自己已经完成
- **AND** 通过的 AcceptanceResult SHALL 与助手消息和 `run.completed` 在同一事务持久化
- **AND** AcceptanceResult SHALL 记录策略、版本、状态、原因码和 ToolCall 证据 ID

#### Scenario: Weather candidate fails independent acceptance

- **GIVEN** 天气候选正文缺少地点、数据时间、来源或可绑定的结果事实
- **WHEN** Runtime 执行天气结果验收
- **THEN** Runtime SHALL 记录 rejected AcceptanceResult 并把 Run 收口为 `failed`
- **AND** Runtime SHALL NOT 持久化候选助手消息
- **AND** 对需要验收的流式 Run，Runtime SHALL NOT 在验收通过前向渠道交付候选正文

#### Scenario: Accepted candidate delivery fails after completion commit

- **GIVEN** AcceptanceResult、助手消息和 `run.completed` 已在同一事务提交
- **WHEN** 当前渠道在接收验收后的暂存正文时关闭连接或回调失败
- **THEN** Runtime SHALL NOT 把已完成 Run 改写或误报为执行失败
- **AND** Runtime SHALL NOT 新增 `run.failed` 终态事件或再次执行 Connector
- **AND** 渠道 SHALL 能使用原 `requestId` 幂等重放或通过 `latestRun` 读取同一已完成结果

#### Scenario: User explicitly cancels a running generation

- **GIVEN** 渠道已通过 `run-started` 获得当前 `runId`
- **AND** Run 状态为 `running`
- **WHEN** 渠道请求 `POST /api/runtime/conversations/{conversationId}/runs/{runId}/cancel`
- **THEN** Runtime SHALL 校验 Run 属于当前会话且当前身份有权操作
- **AND** Runtime SHALL 取消当前模型调用及尚未开始的自动重试或退避
- **AND** 调用方取消 SHALL NOT 触发新的模型尝试
- **AND** Run SHALL 进入独立的 `cancelled` 终止状态，不得记录为普通 `failed`
- **AND** 如果已经产生非空文本增量，Runtime SHALL 至多持久化一条状态为 `interrupted` 的助手消息，并保留已交付的部分内容
- **AND** 如果尚未产生非空文本增量，Runtime SHALL NOT 创建空助手消息
- **AND** Demo Server SHALL 通过当前流发送 `cancelled` 终止事件，并通过会话事实事件发布最终 Run 和可选中断消息状态

#### Scenario: Cancellation is repeated or races with completion

- **GIVEN** 目标 Run 已处于 `completed`、`cancelled` 或 `failed` 终止状态
- **WHEN** 渠道重复请求同一取消端点
- **THEN** Runtime SHALL 幂等返回当前终止状态且不得改写消息、Run 或 usage

#### Scenario: Streaming connection closes without an explicit cancellation

- **GIVEN** Run 仍在执行
- **WHEN** 浏览器刷新、网络中断或 SSE 连接关闭，但渠道没有请求 Run 取消端点
- **THEN** Runtime SHALL NOT 将连接关闭解释为用户取消
- **AND** Runtime SHALL 继续按既有断连恢复语义完成或失败，并允许渠道通过 `latestRun` 查询最终状态

#### Scenario: Request is retried

- **GIVEN** 相同 `requestId` 的 Run 已完成
- **WHEN** 渠道重复提交请求
- **THEN** Runtime SHALL 返回已完成结果且不得重复写入消息或重复调用模型

#### Scenario: User retries, regenerates, or continues as a new Run

- **GIVEN** 当前会话存在一个已持久化的来源 Run
- **WHEN** 浏览器创建新的 Run，并同时提交新的 `requestId`、`clientMessageId`、`sourceRunId` 和 `recoveryMode`
- **THEN** `recoveryMode` SHALL 只允许 `retry`、`regenerate` 或 `continue`
- **AND** Runtime SHALL 校验来源 Run 属于当前会话，且 `retry` 对应 failed、`regenerate` 对应 completed、`continue` 对应 cancelled
- **AND** 新 Run SHALL 继续经过普通输入校验、Context Planner、GatewayClient、持久化和流式交付主链
- **AND** Runtime SHALL 在新 Run 中持久化来源关系，不得修改、删除或覆盖来源 Run 及其消息
- **AND** 恢复动作 SHALL NOT 复用来源 Run 的幂等标识

#### Scenario: Two clients submit to one conversation concurrently

- **GIVEN** 两个客户端同时向同一 Runtime 实例的同一会话提交不同 Run
- **WHEN** 两个请求都通过输入校验
- **THEN** Runtime SHALL 按 `conversationId` 串行执行两个 Run
- **AND** 持久化消息 SHALL 保持完整的 `user -> assistant` 轮次顺序，不得交叉写入回答

#### Scenario: Request has no current input

- **WHEN** `message`、`imageUrls`、`documentUrls` 和 `references` 均为空或缺失
- **THEN** Demo Server SHALL 返回 `400` 输入错误

## ADDED Requirements

### Requirement: Versioned Runtime scenario evaluation

系统 SHALL 以 `runtime-scenario.v1` 保存可版本化 Runtime 场景资产，并由同一通用 Runner 分别执行确定性链路回归和真实模型质量评测；场景业务规则 SHALL 归属场景资产或 Acceptance Policy，不得写入通用 Runner。

#### Scenario: One scenario asset supports deterministic and real-model modes

- **GIVEN** 一个场景声明 fixture 版本、Prompt 版本、支持模式、固定生成参数、Run 输入、故障点、工具 fixture、固定模型决策和独立验收器
- **WHEN** 维护者分别以 `deterministic` 和 `real-model` 运行该场景
- **THEN** 两种模式 SHALL 复用同一份 Run 输入、ToolResult fixture、故障点和独立验收条件
- **AND** `deterministic` 模式 SHALL 通过现有 Runtime、GatewayClient 和固定行为模型验证 SQLite、恢复、调用次数与判分链路
- **AND** 固定行为模型 SHALL 根据当前模型请求中可见的 ToolResult 决策，不得依赖 Runner 隐藏轮次或业务关键词分支

#### Scenario: Real-model mode evaluates only the post-checkpoint answer

- **GIVEN** 场景支持 `real-model` 且调用方显式指定固定模型别名
- **WHEN** Runner 执行进程故障与重启恢复场景
- **THEN** setup 阶段 SHALL 使用固定行为模型经现有 Runtime 和 Tool Registry 构造 completed ToolResult 稳定点
- **AND** evaluation 阶段 SHALL 只通过现有 `GatewayClient -> AI SDK -> LiteLLM -> 上游模型` 生成最终回答
- **AND** 真实模型超时、鉴权、限流、网关错误或验收失败 SHALL 直接形成失败结果
- **AND** Runner SHALL NOT 回退固定行为模型或重新执行 Connector 来掩盖真实失败

#### Scenario: Scenario report separates setup and evaluation evidence

- **WHEN** Runner 完成或终止一个场景
- **THEN** `runtime-scenario-report.v1` SHALL 分开记录 setup 与 evaluation 的请求数量、完成响应数量、失败数量、阶段耗时和 token
- **AND** 报告 SHALL 记录场景版本、Prompt 版本、固定生成参数、请求模型别名、可空实际模型、延迟、Run 状态和独立验收结果
- **AND** 实际模型 SHALL 只来自已完成的 chat completion 响应，不得根据请求别名推断
- **AND** 报告 SHALL NOT 保存 Prompt 正文、回答正文、ToolResult 正文、密钥或 provider 原始响应体
- **AND** 真实模型已执行样本不足 30 时 SHALL 标记为 `observation-only`，不得作为质量发布基线

# Runtime 生命周期事件端口与渠道交付解耦

- 状态：接受
- 日期：2026-08-13
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 渠道与体验层 / 治理与可观测
- 关联需求：对照 Agent Harness 的 Event、Session 与 Acceptance 分层，收敛同步输出的职责边界
- 对照材料：[从 Pi 到 Mini Pi：重新实现一次 Agent Harness](https://mp.weixin.qq.com/s/2z9R-aMoJc4ODf-FjlPz7w)
- 关联 OpenSpec：不改变 `openspec/specs/ai-platform/spec.md` 的 JSON/SSE 外部行为
- 替代记录：无；细化 `2026-07-29-existing-capability-selection-audit.md` 的流式交付边界

## 问题

重构前，`chat-runtime.mjs` 通过 `onTextDelta`、`onToolEvent`、`onArtifactCreated` 等渠道回调直接交付执行过程。SSE、Trace 和故障注入因此以不同回调形状进入 Runtime；订阅者异常还可能沿模型或工具调用栈反向改变 Run 结果。成功证据是：Runtime 不认识 SSE 或 UI 协议，生命周期事件可由多个观察者复用，任一观察者失败不改变已经生成或提交的执行事实，同时现有 HTTP 事件顺序保持兼容。

## 与 Agent Harness 文章的边界对照

| 文章中的结构 | 当前项目落地 | 对齐判断 |
| --- | --- | --- |
| Agent / Loop | `GatewayClient` 以 AI SDK `ToolLoopAgent` 执行有界模型与工具循环，`chat-runtime.mjs` 负责 Session/Run 应用编排 | 已对齐；Loop 不拥有渠道协议、事实存储或验收规则 |
| Session | SQLite 保存 Conversation、Message、Run、ToolResult、AcceptanceResult、MemoryDelta 和事务事件 | 已对齐且事实语义更强；不是把聊天数组当 Session |
| Context Compiler | `Context Planner` 从完整事实、active 记忆、Episode、引用和最近消息构造预算内 Model Input 与 Context Manifest | 已对齐；“系统拥有的事实”和“模型本轮看到的视图”已分离 |
| Event | `RunEventSink` 发布易失、有序、不可变的生命周期事件，SSE 和测试在边界外订阅 | 本次补齐；Event 只观察，不再以渠道回调介入 Runtime |
| Trace | `ChainTracer` Port 与 OpenTelemetry 记录阶段、时长和错误分类，不写业务事实 | 原则对齐；精确阶段 Span 仍由 Runtime 显式埋点，不强行退化为普通 Event 订阅者 |
| Hook / Policy | `ExecutionPolicy` 对 Run/Tool 做版本化前置决策，未知操作默认拒绝；前置 Hook 只能收紧，后置 Hook 只观察且失败隔离 | 执行治理基础已对齐；Sandbox 与外部策略发布仍未实现 |
| Application Acceptance | `result-acceptance.mjs` 根据持久化 ToolResult 独立验收天气候选，并原子保存 AcceptanceResult 与终态 | 已对齐；模型完成不等于系统接受完成 |
| Durable Harness | completed 只读 ToolResult 后支持受限重启恢复；Operation journal 与 SQLite RunLease/fencing 支持过期接管和旧 owner 拒绝 | 协调基础已补齐；生产多实例、跨实例取消和有副作用动作恢复仍未完成 |

因此，本次目标不是复制 Mini Pi 的类名或目录，而是保持相同职责原则，并让当前平台已有的 SQLite 事实源、独立验收和窄恢复能力继续各自内聚。同步输出的目标结构是 `Runtime -> RunEventSink -> Channel Adapter`，不是 `Runtime -> SSE callback`；可恢复同步仍是 `SQLite conversation_events -> cursor SSE`，两条链不合并。

后续状态：执行治理 change 已新增 `ExecutionPolicy / Hooks`、Operation journal 与 SQLite `RunLease`/fencing。它们沿用本记录的解耦原则：Policy 只决策，Runtime 只编排，Store 独占事实，Connector 只执行；不改变 `RunEventSink` 的易失观察语义，也不把 Sandbox 或写操作 exactly-once 宣称为已完成。

## 约束与非目标

### 必须满足

- SQLite 继续是 Conversation、Run、Message、ToolResult、AcceptanceResult 和可恢复事件的唯一事实源。
- `text.delta` 等实时事件保持易失，不逐 Token 持久化，也不提供断点续传。
- POST SSE 的 `run-started`、工具事件、`text-delta`、资产事件和终止事件名称与顺序保持不变。
- A3 候选仍须在 AcceptanceResult 与 Run 终态提交后才能发布正文。
- 订阅者不得修改事件快照，订阅者异常不得让模型、工具或 Run 失败。

### 本次不解决

- 不建设进程间消息总线、Outbox、DeliveryAttempt、保证送达或消费位点。
- 不用实时事件替代 SQLite `conversation_events`、ChainTrace 或业务审计。
- 不切换到 AI SDK UI Message 协议，也不改变浏览器 Runtime Adapter。
- 不为尚未出现的跨服务消费者承诺公共事件版本。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| AI SDK UI Message Stream | 成熟一体化 | AI SDK 模型与工具分块到 Web UI 消息流 | 与 AI SDK UI 生态内聚，提供现成 Web 传输结构 | 会把 Runtime 内部生命周期绑定到 UI 协议，仍不能表达 SQLite 事实与独立验收所有权 | 已安装 `ai@7.0.37` 的 `createUIMessageStream`、`toUIMessageStream` |
| Node `EventTarget` / `EventEmitter` | 轻量可组合 | 进程内发布订阅 | 标准运行时能力，无新增依赖 | 默认同步监听和错误行为不符合异步订阅隔离；类型、不可变性和交付报告仍需项目适配 | Node.js 24 运行时 |
| 项目自有 `RunEventSink` Port | 最小自研 | Runtime 生命周期事件、顺序发布与订阅失败隔离 | 只表达当前稳定变化点；SSE、Trace、测试均在边界外适配 | 只能维护为小型进程内 Port，不得扩展成通用事件平台 | 现有 Runtime、Demo Server 与测试调用链 |

## 淘汰条件

- 候选让渠道协议成为 Runtime 核心数据模型，或产生第二个执行事实源。
- 观察者异常能够让已提交 ToolResult、ImageAsset 或 Run 改写为失败。
- 为单进程同步输出引入服务、Broker、持久游标或另一套消息历史。
- 事件中泄露工具输入、完整 ToolResult、模型原始错误或其他敏感正文。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| Runtime 可不依赖 SSE 回调完成现有主链 | Demo Server 将 `RunEvent` 映射为原 SSE | 普通文本、图片、取消、断线 | 通过；HTTP SSE 聚焦测试事件序列未变 | `scripts/test-streaming-http.mjs` |
| 订阅者失败不改变执行事实 | 首个订阅者尝试修改事件并在每个文本增量抛错，第二个订阅者继续收集 | 两段文本流 | 通过；事件不可变、第二订阅者收到完整顺序、Run completed | `scripts/test-runtime.mjs` |
| 工具、图片和 Trace 可共享同一端口 | 将原回调调用点迁到事件订阅者 | 天气工具、图片资产、C1 Trace | 通过；聚焦测试均通过 | `scripts/test-runtime.mjs`、`scripts/test-image-generation.mjs`、`scripts/test-chain-trace.mjs` |

## 决策

- 结论：适配
- 选择方案：项目自有 `RunEventSink` Port，使用 Observer + Port/Adapter。
- 决策依据：当前需要的只是一个进程内、顺序、不可变且隔离订阅失败的生命周期端口。AI SDK UI Stream 属于渠道协议，Node 原生发布器缺少本项目的异步失败语义；引入任何持久事件基础设施都会超过当前问题规模。
- 平台拥有：Runtime 事件类型、最小公开载荷、顺序、不可变性、订阅失败隔离，以及实时事件与事实事件的边界。
- 外部方案负责：AI SDK 继续产生模型流；Demo Server 负责 SSE；OpenTelemetry 负责 Trace 导出；SQLite 负责事实历史。
- 明确不实现：Broker、Outbox、重放、事件 Schema Registry、跨服务消费组和 UI Message Stream 替换。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| AI SDK UI Message Stream 作为 Runtime 内部协议 | 它解决 Web UI 分块，不拥有 Run、AcceptanceResult 和 SQLite 事实语义 | 多个 Web 产品统一采用 AI SDK UI 协议时，在 Demo Server Adapter 层评估 |
| 直接使用 `EventEmitter` / `EventTarget` | 仍需封装异步顺序、不可变快照和错误隔离，直接暴露不会减少边界代码 | Node 标准 API 出现完全匹配的异步隔离语义 |
| Redis Streams、Kafka 或 NATS | 当前没有跨进程消费者、保证送达和积压处理需求 | Runtime 拆服务、出现多个独立消费者或明确的交付 SLO |

## 实施边界

`chat-runtime.mjs` 只依赖 `RunEventSink.publish(event)`，不引用 SSE 事件名。`scripts/demo-server.mjs` 装配 Trace 和 SSE 订阅者，并把 `run.started`、`text.delta`、`tool.*`、`artifact.created` 映射为既有渠道协议。终止响应仍由 HTTP Adapter 在 Runtime 返回或抛错后发送，避免把完整结果和 HTTP 状态塞回 Runtime 事件。

`RunEventSink` 对每次发布创建结构化克隆并深冻结，按注册顺序等待订阅者；单个订阅者错误由 `onSubscriberError` 旁路观察，随后继续下一个订阅者。SQLite `conversation_events` 仍在业务事务内提交，负责恢复和多端事实同步；两者不能互相替代。

## 风险与退出路径

- 已知风险：慢订阅者仍会增加当前 Run 延迟；当前订阅者只有本地 SSE 写入、Trace 属性和测试故障注入，不引入远程 I/O。需要远程订阅时先加有界队列或成熟 Broker，不能直接塞入 Sink。
- 锁定点：项目自有的少量 Runtime 事件类型与既有 SSE 映射。
- 退出路径：渠道 Adapter 可逐个替换；若未来采用 Broker，保持 Runtime Port 并替换 Sink 实现，SQLite 事实数据无需迁移。
- 维护责任：AI 应用基础平台维护者负责事件最小化、失败隔离、SSE 兼容和事实边界。

## 验收与完成报告

- 验证证据：`npm test` 全量 `103/103`、架构边界 `4/4`、Demo 构建与 gzip 预算、`openspec validate --specs --strict`、语法检查和 `git diff --check` 全部通过。
- 剩余边界：无跨进程发布、无 DeliveryAttempt、无保证送达、无 Token 级恢复；普通 C1 仍为 A0。
- 文档与契约：同步 `docs/ai-structure.md`、`docs/scenario-interaction-chains.md` 和决策索引；外部 JSON/SSE 行为未改变，因此稳定 OpenSpec 无需改写。
- 重评条件：出现独立 Runtime 服务、多实例实时消费者、必须重放的生命周期事件、渠道交付 SLO，或多个 Web 产品明确统一 AI SDK UI Message 协议。

# Runtime 智能操作路由采用会话上下文快照与可验证模型证据

- 状态：接受
- 日期：2026-08-15
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 治理与可观测
- 关联需求：让“继续优化”“颜色没有变化”“输出图片”等依赖前文的输入在刷新和澄清轮之后仍能选择正确 operation 与源图
- 关联 OpenSpec：`openspec/changes/add-smart-operation-routing/`
- 替代记录：[`2026-08-02-runtime-smart-operation-routing.md`](./2026-08-02-runtime-smart-operation-routing.md)

## 问题

2026-08-02 的首版智能路由解决了用户发送前必须在“对话 / 生图 / 图生图”中三选一的问题，但分类阶段只读取当前消息和当前附件。会话历史虽然会在 operation 已确定后进入对话 Context Planner，却不能影响更早发生的 operation 选择。图片编辑完成得到 B 后，用户先追问“颜色没有变化吧”，再说“自己判断吧”或“输出图片”时，当前请求没有附件；Router 因而看不到 B 和近期编辑要求，解析成 `conversation.chat`。此时文本模型即使理解用户想继续编辑，也无权把已经锁定的对话 Run 改成图片操作，只能报告当前没有图片编辑或导出工具。

问题不在某个中文短语或单一模型，而在路由阶段缺少可追溯的会话工作上下文。成功证据是：`上传 A -> 编辑得到 B -> 视觉澄清 -> 无附件继续优化` 能从服务端事实恢复 B，结合近期不可变消息解析为 `image.edit`，以 B 为源生成新资产 C；刷新、幂等重放和同会话并发下不依赖前端缓存，也不会把无关聊天、非法历史证据或跨会话资产带入图片模型。

## 约束与非目标

### 必须满足

- Agent Runtime 继续拥有 operation 最终判定；所有业务模型请求仍经 GatewayClient 和 LiteLLM，渠道与分类模型不得直接调用图片能力。
- 活动图片必须从 SQLite 中已提交的 Message、真实 Run operation 和可用 `image_asset` 事实确定性推导，不新增由前端或异步 Memory Manager 维护的第二个图片事实源。
- Router 只能读取有消息数量、单条正文字符和字段边界的 routing snapshot；`routing-context.v2` 只投影 committed 消息，并在截断前把历史 HTTP(S)/data URL 替换为占位符，不得把 interrupted 片段、完整会话、图片二进制、附件 URL 或 storageKey 交给分类模型。
- 显式当前附件优先于历史活动图片，并在分类前校验类型、数量、会话所有权、状态和过期时间；模型输出不得覆盖这些硬约束。
- 分类模型只返回 `operation`、`confidence`、`useActiveImage` 和 `relevantMessageIds`，不得选择 assetId、模型、尺寸、provider 参数或自由生成编辑 Prompt。
- Runtime 必须校验候选 operation、置信度、历史证据 ID 和活动图片可用性，再选择真实源资产和组装业务输入；无效证据或过期快照不得产生图片副作用。
- Run 必须持久化脱敏、版本化的 `intentDecision`，并以真实 operation、实际消息/资产引用和快照版本支持审计、幂等与重放；不得保存 provider 原始分类文本或隐藏推理。
- 确定性无模型链路回归和真实模型识别评测必须分开报告，脚本分类器通过不得被表述为真实模型准确率。

### 本次不解决

- 多图融合、远程图片导入编辑、遮罩、局部重绘、画布坐标或像素级区域选择。
- 用异步长期记忆替代同步 routing snapshot，或让 Memory Manager 决定本轮 operation。
- 通用 Agent 工作流、跨会话图片继承、在线阈值学习或由模型直接执行工具。
- 在分类结果中保存思维链、provider 原始输出、图片内容或完整会话正文。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 用 LangGraph 等有状态 Agent Runtime 重建会话与路由 | 成熟一体化 | Checkpoint、线程状态、节点路由和恢复 | 状态图、持久化与条件分支内聚，operation 增长后可扩展为长工作流 | 会替换现有 Session/Run、SQLite、幂等、Lease、Policy 和恢复所有权；为三个 operation 引入迁移与双写成本 | [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、当前 Runtime 数据所有权审计 |
| 现有 Runtime 派生 routing snapshot，适配 AI SDK 结构化输出 | 轻量可组合 | 同步历史投影、候选约束、模型分类、证据校验和审计 | 复用既有不可变事实、GatewayClient 与 `Output.object`；变更集中在 Runtime Port，分类器可替换 | 平台需要维护小型快照投影、校验器、Prompt 组装和评测资产 | AI SDK Core v7 既有结构化输出路径、ConversationStore/Context Planner 事实边界 |
| 前端保留最近图片，或为 Conversation 增加可变 activeAssetId 与关键词规则 | 最小自研 | 当前源图续接和少量短语判断 | 调用少、实现表面简单 | 刷新/多端会漂移；聊天轮可能清空状态；关键词无法处理否定、指代和多语言；可变指针可能与不可变消息及 Run 冲突 | 已复现的无附件续接失败与当前 Composer 生命周期 |

## 淘汰条件

- 方案要求渠道保存或重传“当前图片”才能恢复服务端 operation。
- 分类模型能够返回或伪造 assetId、模型别名、图片参数、完整 Prompt 或不可验证的历史正文。
- 无效 `relevantMessageIds`、跨会话资产、过期资产或已变化的快照仍可触发 `image.generate` / `image.edit`。
- 活动图片被普通无关聊天清空，或显式当前附件不能覆盖历史图片。
- 确定性脚本结果与真实模型识别率混在同一通过率中，无法区分链路缺陷和模型质量。
- 为三个 operation 引入第二套会话、Run、Checkpoint 或工作流事实源。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 当前结论 | 证据位置 |
| --- | --- | --- | --- | --- |
| 失败来自路由上下文缺失而非图片编辑链不可用 | 复盘同一会话的消息、Run operation 和图片引用 | `编辑 -> 澄清 -> 自己判断 -> 输出图片` | 已确认：首轮编辑成功；后续无当前附件的请求均在业务模型前解析为对话 | `src/runtime/run-intent-router.mjs`、`src/runtime/chat-runtime.mjs`、`demo/src/App.jsx` |
| 活动图片可由既有不可变事实重建 | 检查图片上传、用户引用、completed 图片产物和会话资产所有权 | A -> B -> C、多轮聊天、刷新投影与并发快照变化 | 通过直接确定性回归；聊天轮不清空活动图片，第二次编辑以 B 为源，快照冲突只重路由一次 | `src/storage/conversation-store.mjs`、`scripts/test-image-generation.mjs`、`scripts/test-runtime.mjs` |
| 模型可以只表达意图而不拥有资产选择 | 将 schema 收窄为四个字段，Runtime 反查候选、证据和资产 | `operation/confidence/useActiveImage/relevantMessageIds` | 通过 Router 回归；分类输入不含私有 assetId，伪造证据安全回退对话 | `src/runtime/run-intent-router.mjs`、`scripts/test-runtime.mjs` |
| 识别质量可与图片副作用链隔离验证 | 确定性模式使用脚本分类器和 fake 图片模型；真实模式只替换分类器 | 固定 fixture、模型别名、Prompt/schema 与采样参数 | 双模式 Runner 已落地；确定性场景通过，真实 `gpt-5.6` 首个 4 轮场景只作 `observation-only` | `.agents/skills/docs/context-memory-evaluation/`、`scenarios/runtime-routing/` |

## 决策

- 结论：适配。
- 选择方案：在现有 Agent Runtime 内增加从不可变事实派生的有界 routing snapshot，继续适配 AI SDK Core `Output.object` 完成结构化分类；Runtime 对模型证据做确定性校验并拥有源资产选择、Prompt 组装和真实 operation 持久化。
- 决策依据：问题规模仍是三个既有 operation 的前置路由，不需要替换 Session/Run Runtime。现有 SQLite 已拥有消息、Run 与图片资产事实，AI SDK 已提供结构化输出；平台新增的只是与自身数据所有权紧密相关的投影、校验和审计，边界小且可用确定性测试覆盖。
- 平台拥有：routing snapshot 投影和版本、活动图片推导、候选矩阵、证据校验、阈值、安全回退、源资产选择、Prompt 组装、`intentDecision`、幂等与评测协议。
- 外部方案负责：AI SDK 负责结构化输出协议，LiteLLM 负责模型别名和上游访问，分类模型只在 Runtime 给定的候选和有界上下文中表达意图。
- 明确不实现：前端关键词路由、可变 activeAssetId 事实表、分类模型资产选择、全量会话分类输入、模型生成不可追溯编辑指令和通用工作流引擎。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| LangGraph 等成熟一体化 Runtime | 当前只需补齐路由前的只读上下文视图；迁移会重叠既有 Run、Store、Lease、Policy、恢复和事件所有权，成本显著大于能力收益 | operation 与长任务节点显著增长，需要跨进程 checkpoint、人工节点、分支恢复或图级可观测 |
| 前端保存最近图片 | 渠道不是会话事实源，刷新、多标签页和未来 IM/API 无法一致恢复；也不能完成会话所有权和资产状态校验 | 不重评；渠道可缓存服务端投影改善显示，但不得成为路由依据 |
| Conversation 可变活动图片指针 | 会与 Message/Run/asset 不可变事实形成双写、故障顺序和并发一致性问题；当前可通过有界投影得到 | 会话历史规模导致投影无法满足延迟目标，且可证明的物化投影/版本更新方案优于查询派生 |
| 服务端关键词或规则分类器 | 可处理固定命令，却不能可靠解释否定、指代、澄清与跨语言语义；规则样本会侵入业务实现 | 业务输入收敛为有限命令语法，或真实模型延迟/成本长期超过目标且规则评测达到相同门槛 |

## 实施边界

### Routing snapshot 与活动图片

Runtime 在分类前读取版本化、有界 routing snapshot。当前 `routing-context.v2` 只包含 committed 近期消息（稳定 messageId、顺序、角色、脱敏正文投影及关联真实 Run operation）和一个可空活动图片投影；interrupted 助手片段默认排除，历史 HTTP(S)/data URL 在字符截断前替换为稳定占位符，SQLite 原始 Message 保持不变。快照不得包含图片二进制、storageKey、provider 正文、附件地址或预算外完整历史。消息上限、单条正文字符上限和投影版本必须固定；分类实际 token 进入真实模型评测报告。

活动图片不是独立可写字段。Store 按消息顺序从已提交事实中选择最近的合格 `image_asset` 引用：资产必须属于当前会话、可用且未过期；助手图片必须来自 completed `image.generate` / `image.edit` Run，用户图片必须是该消息已持久化的唯一受控引用。没有图片引用的普通聊天只是不产生新候选，不会清空此前投影；上传但尚未进入消息的文件、远程 URL、多图和跨会话资产均不能成为活动图片。每次读取都重新校验资产状态，因此删除或过期资产不会被历史 ID 重新激活。

### 候选、模型输出与确定性校验

| 当前事实 | 候选 operation | 图片输入约束 |
| --- | --- | --- |
| 当前恰好一张合法显式 `image_asset`，无其他附件 | `conversation.chat`、`image.edit` | 显式资产覆盖历史活动图片，并作为当前视觉/编辑源 |
| 无当前附件，存在活动图片 | `conversation.chat`、`image.generate`、`image.edit` | `image.edit` 必须使用活动图片；`conversation.chat` 仅在校验后的 `useActiveImage=true` 时继承；`image.generate` 不继承 |
| 无当前附件，也无活动图片 | `conversation.chat`、`image.generate` | 不允许 `image.edit` 或视觉继承 |
| 远程图片 URL、文档链接、多图、未知引用或 `conversation_message` 引用 | 仅 `conversation.chat` | 不隐式继承活动图片，不产生图片副作用 |

分类器接收当前规范化文本、上述候选、活动图片是否存在及有界历史消息，只能返回：

```json
{
  "operation": "conversation.chat | image.generate | image.edit",
  "confidence": 0.0,
  "useActiveImage": false,
  "relevantMessageIds": ["message-id"]
}
```

Runtime 将 operation 钳制在候选中，将 `relevantMessageIds` 校验为当前快照内、顺序有效且数量受限的真实消息 ID。当前输入始终由 Runtime 确定性加入业务 Prompt，不要求分类器把它列为证据；视觉对话的当前问题本身自包含时证据数组可以为空，依赖前文的隐式编辑则必须至少返回一条有效历史消息。历史编辑要求只从校验通过的消息正文按原顺序组装，不接受分类器自由生成的替代 Prompt。无当前附件的 `image.edit` 必须同时满足 `confidence >= 0.85`、`useActiveImage=true`、存在可用活动图片且至少一条历史证据有效；`image.generate` 必须满足阈值且不得携带活动图片。视觉对话只有在 `useActiveImage=true` 且所有声明的证据有效时才继承活动图片；无关聊天不携图。候选越权、低置信度、非法证据、失效资产、结构错误、分类非取消失败或预算不足均安全回退为不继承历史图片的 `conversation.chat`，不得调用图片模型或创建新资产。

### 事实、并发与重放

Runtime 选择源资产并组装输入后创建 Run。`intentDecision` 保存 schema/router/context strategy 版本、解析与分类 operation、confidence/threshold、决策来源、候选、`useActiveImage`、校验后的 `relevantMessageIds`、context version 和截断标记；实际 assetId 继续以受控 Message/Run 图片引用保存，不依赖分类器输出。Run、用户消息、真实引用和 intentDecision 必须在一致的提交边界内落库，不保存 provider 原始输出。

分类期间若会话版本变化，Runtime 不得使用过期证据或源图执行图片操作；实现可在有界次数内重新读取和分类，持续冲突则返回稳定 `routing_context_changed`。相同 requestId 必须优先命中既有 Run 并使用其真实 operation、引用和 intentDecision，不重新分类。分类阶段不持有图片副作用 Lease；图片调用只能在 Run 创建、ExecutionPolicy 允许且取得有效 Lease 后发生，调用前再次读取并校验源图字节。

### 双模式评测

新增独立 `scenarios/runtime-routing/` 场景协议，不把图片路由 fixture 塞入当前以天气恢复为边界的 `scenarios/runtime/`：

- `deterministic` 使用 fixture 驱动的脚本分类器与 fake 图片 Gateway，验证 snapshot、候选、证据校验、实际编辑源字节、视觉模型图片输入、编辑 Prompt 历史、Run/Message/intentDecision、幂等、刷新恢复和错误图片副作用为零。
- `real-model` 只把分类器替换为经现有 GatewayClient/LiteLLM 调用的固定模型，图片生成/编辑继续使用 fake，隔离“模型是否识别意图”和“真实图片模型是否成功/昂贵”。

场景输入和标准答案必须位于版本化 fixture，不在 Runner 写关键词分支。固定模型别名、实际模型、Prompt/schema 版本、采样参数和 fixture 版本；Runner 直接观测业务 Gateway 的实际源图字节、视觉输入、编辑 Prompt 和失败图片调用，报告 operation、错误图片副作用、源资产引用/字节、视觉输入、编辑 Prompt 历史、活动图片、证据、token、平均延迟和 P95。最小回归固定覆盖 `A -> 编辑得 B -> 视觉澄清 -> 无附件继续优化 -> 以 B 得 C`，并增加无关聊天、新图生成、显式旧图覆盖、低置信度、非法证据、跨会话资产、刷新和幂等样本。通过动态 schema 校验的真实分类样本少于 30 时只标记 `observation-only`，不得把未调用分类器的轮次或小样本结果作为发布准确率。

## 风险与退出路径

- 已知风险：路由历史增加分类 token 和首包延迟；有界窗口可能遗漏更早指令。必须记录截断、token 和延迟，并通过 fixture 调整窗口，而不是无界发送会话。
- 已知风险：高置信度仍可能误判。显式附件、候选钳制、证据校验、图片阈值和单次图片尝试共同限制影响；真实模型报告用于发布判断，不自动更新阈值。
- 锁定点：平台的 snapshot/intentDecision 契约与不可变事实投影；分类 Adapter 保持可替换，不依赖 provider 原始响应。
- 退出路径：真实模型可替换为本地分类器、规则与模型混合分类器或成熟路由节点；关闭智能路由时可恢复显式 operation，既有 Run 无需迁移。
- 维护责任：Agent Runtime 维护投影、候选、校验、Prompt 和审计；治理与可观测维护 fixture、指标和发布阈值；渠道只展示服务端活动图片投影并发送当前输入。

## 验收与完成报告

- 验证证据：2026-08-15 全量 `npm test` 为 `165/165`，新增路由场景测试 `7/7`，确定性路由场景 `1/1`，架构边界 `7/7`，`git diff --check` 通过；`add-smart-operation-routing` 与 stable spec 的 OpenSpec strict validate 通过。最终代码的真实 `gpt-5.6` 分类 smoke 共 4 个有效样本，operation、源图引用、源图字节、视觉输入、编辑 Prompt 历史、证据和活动图片指标均为 1，错误图片副作用率为 0，总 token 为 21,482，路由平均约 5.04 秒、P95 约 6.13 秒。全新浏览器会话也完成 A→B→无附件视觉核查→无附件续改→C，刷新后活动图片仍为 C。
- 剩余边界：真实分类样本只有 4 轮，只能标记 `observation-only`；无关聊天、新图生成、显式旧图覆盖、低置信度、跨会话资产等完整版本化 fixture 矩阵仍待补齐。不能宣称真实模型已稳定识别所有指代，也未提升 C2 的内容安全、质量、成本或生产可靠性等级。
- 文档与契约：同步 stable OpenSpec、`add-smart-operation-routing` change、场景链和决策索引。
- 重评条件：真实模型 operation 准确率或证据有效率低于发布阈值、错误图片副作用率不为零、P95 路由延迟/成本不可接受、投影查询成为瓶颈，或 operation 演进为需要持久工作流的复杂图。

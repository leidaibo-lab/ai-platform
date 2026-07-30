# C1 渠道体验采用 Ant Design X

- 状态：接受
- 日期：2026-07-29
- 负责人：AI 应用基础平台维护者
- 所属区域：渠道与体验层
- 关联需求：在不替换 Agent Runtime、会话事实源和现有 SSE 契约的前提下，补齐 C1 对话的输入、生成状态、结果展示、取消和引用体验
- 关联 OpenSpec：`openspec/specs/ai-platform/spec.md`
- 替代记录：无
- 后续补充：`2026-07-30-c1-model-selection-and-failure-feedback.md` 扩展 Run 模型选择与分类失败反馈，不改变本记录的 UI 方案结论

## 问题

当前 C1 Demo 已具备多会话、附件输入、乐观消息、POST SSE 文本流和运行上下文查看能力，但交互仍以开发验证为主：输入、生成过程、异常恢复、结构化结果和消息操作缺少统一组件与状态表达。继续在单文件静态页面中自研 AI 交互组件，会让渠道层长期维护输入框、附件、消息列表、流式 Markdown、操作按钮和可访问性等通用能力，不能形成平台差异化。

本次目标是选择成熟的 AI 对话体验方案，由渠道层适配现有 Runtime API，并为后续正式 Web 渠道建立可复用的 C1 体验基线。成功证据包括：现有 Run/SSE/会话事实核心语义保持兼容，取消与引用通过独立契约扩展，输入、流式结果和异常状态能够稳定映射，桌面与移动视口可回归验证。

## 约束与非目标

### 必须满足

- 所有业务模型请求继续经过 Agent Runtime，不新增浏览器直连模型或模型网关的入口。
- SQLite 仍是当前 Conversation、Message 和 Run 的事实源；UI 状态不得替代服务端事实。
- 保留现有 JSON Run、POST SSE 模型文本流和基于事件游标的会话事实流，不为 UI 框架迁移 Runtime 协议。
- 渠道层只能展示可验证的执行阶段、工具状态和来源，不得展示模型原始思维链。
- 新 UI 依赖必须锁定精确版本，并通过 Adapter 隔离组件状态与 Runtime 契约。

### 本次不解决

- 不接入点赞、点踩及其反馈存储和评测闭环。
- 不允许删除或原位修改已持久化消息；用户纠正继续通过追加新消息表达。
- 不提前实现文档片段、网页、工具结果等尚未进入对应场景链路的引用类型。
- 不引入 Ant Design X SDK 替换现有数据流，也不改变 Agent Runtime、GatewayClient 或 LiteLLM 主链。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| Ant Design X + X Markdown | 成熟一体化 UI | Conversations、Sender、Attachments、Bubble、Actions、生成过程、来源与流式 Markdown | 企业级交互范式完整；与 Ant Design 视觉体系一致；组件可按现有状态受控使用 | 当前 Demo 无 React 构建链，需要迁移渠道页面并控制包体与版本兼容 | [Ant Design X 组件](https://x.ant.design/components/introduce-cn/)、[用户发送规范](https://x.ant.design/docs/spec/expression-user-send-cn/)、[X Markdown](https://x.ant.design/x-markdowns/introduce-cn) |
| AI Elements + AI SDK UI | 轻量可组合 | 基于可组合组件构建消息、输入、推理状态和工具结果 UI | 与项目已有 AI SDK 生态接近，组件粒度灵活 | 容易把 UI 消息协议与现有事实流、POST SSE 混为一体；当前没有多 Web 渠道统一 AI SDK UI 协议的需求 | [AI Elements](https://ai-sdk.dev/elements/overview) |
| 继续扩展当前静态 Demo | 最小自研 | 在 `demo/index.html` 内逐项增加交互 | 迁移成本最低，完全沿用现有页面 | 需要持续自研通用 AI 组件、Markdown、安全渲染、可访问性和响应式行为，长期维护成本高 | 当前 `demo/index.html` |

## 淘汰条件

- 要求 Runtime 改用框架专属消息协议，或者让浏览器成为会话事实源。
- 无法通过受控组件或薄 Adapter 映射 `run-started -> text-delta* -> completed/cancelled/error` 事件。
- 必须把模型原始思维链作为 UI 数据源。
- 无法锁定版本、隔离依赖或保留回退到当前 Demo 的路径。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| Ant Design X 覆盖 C1 的主要交互阶段 | 检查官方 RICH 规范和组件 API | 2026-07-29 官方文档，站点版本 2.9.0 | 通过；已覆盖会话、输入、附件、消息、操作和生成过程组件 | 本记录候选证据链接 |
| 流式结果可在不替换 Runtime SSE 的情况下渲染 | 以独立 Adapter 消费 `run-started -> text-delta* -> completed/cancelled/error` | 当前 POST SSE 契约，Ant Design X/X Markdown 2.9.0 | 通过；受控 Bubble 与 X Markdown 完成增量渲染，Adapter 回归覆盖任意网络分块和终止事件 | `demo/src/runtime-adapter.js`、`scripts/test-demo-adapter.mjs` |
| 渠道迁移不需要修改模型调用主链 | 将 React 页面限定为 Demo Server 的入站 Adapter | 当前六区域架构 | 通过；Runtime、SQLite、JSON Run 和 SSE 契约保持不变，未引入 Ant Design X SDK | `demo/src/App.jsx`、`scripts/demo-server.mjs`、`docs/ai-structure.md` |
| 失败与网关异常能够形成可恢复状态 | 构造失败 Run、包含多模态与引用的输入，以及断开的模型网关 | 当前 Conversation/Message/Run 事实和渠道草稿 | 通过；失败提示按 `runId` 锚定用户消息且不暴露内部错误，恢复不复用幂等标识，网关离线时草稿可编辑但发送禁用 | `demo/src/conversation-view-model.js`、`demo/src/App.jsx`、`scripts/test-demo-adapter.mjs` |
| 桌面与移动视口可承载完整 C1 操作 | 浏览器验证会话、消息、引用、附件、输入区和上下文面板 | 1280x720、390x844 | 通过；桌面 Inspector 可收起且无横向溢出，移动端两侧栏进入 Drawer、消息操作收敛为单一菜单，失败卡和网关提示不挤压发送区 | `demo/src/styles.css`、浏览器 PoC |

## 决策

- 结论：适配。
- 选择方案：Ant Design X 与 X Markdown；当前已锁定并验证 2.9.0，React 构建链由 Vite 承载。
- 决策依据：当前是企业级渠道体验，Ant Design X 同时提供设计范式和覆盖 C1 阶段的组件，能够减少通用 AI UI 自研；通过渠道 Adapter 可以保留现有 Runtime 和 SSE 数据所有权。
- 平台拥有：Conversation/Message/Run 契约、取消与引用语义、SSE 事件映射、身份权限、错误分类、事实状态和体验验收指标。
- 外部方案负责：输入框、附件、会话列表、消息展示、操作按钮、流式 Markdown、代码和通用可访问性交互。
- 明确不实现：另一套 UI 消息事实源、框架专属 Agent Runtime、原始思维链展示和当前阶段的反馈闭环。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| AI Elements + AI SDK UI | 当前已有两条恢复语义不同的 SSE 流，迁移 UI 协议不能减少 Runtime 核心复杂度；产品已确认采用 Ant Design X | 多个 Web 产品共同要求 AI SDK UI 协议，且 Adapter 能保留现有 Run 与事实流 |
| 继续扩展静态 Demo | 通用 AI 交互组件不构成平台差异化，长期维护和一致性成本高 | Ant Design X 出现不可接受的兼容、性能、许可证或维护风险 |
| Ant Design X SDK | 当前只需要 UI 组件和 Markdown；替换现有 SSE 数据流会扩大迁移面 | X SDK 能经 PoC 明显减少 Adapter 复杂度，且不改变 Runtime 稳定契约 |

## 实施边界

- 渠道页面使用 Ant Design X 组件，并通过独立 Adapter 消费现有 Runtime JSON/SSE API。
- `Conversations`、`Bubble` 和 `Sender` 的本地状态只负责即时展示；完成态必须由服务端 Conversation/Run 事实收口。
- 会话生命周期与模型生成状态分开表达：`active` 显示为“可继续”，只有活动 Run 才显示“生成中”或“正在停止”。
- 模型网关未确认可达时允许继续编辑渠道草稿，但发送门禁必须阻止创建无效 Run，并提供重新检测入口；该状态只代表 LiteLLM `/v1/models` 可访问，不得表述为上游模型生成可用。
- 最近失败 Run 通过 `latestRun.id -> userMessage.runId` 生成持久失败提示，只显示渠道安全文案；恢复输入必须生成新的渠道附件身份，并在再次发送时创建新的 `requestId` 和 `clientMessageId`。
- `Think` 或 `ThoughtChain` 只映射真实的 accepted、processing、tool、source、completed、cancelled 和 failed 证据；没有服务端事件时不得伪造阶段。
- 消息引用使用稳定、带类型的引用对象；当前 C1 只开放 `conversation_message`，未来来源按场景逐类进入稳定契约。
- 引用预览按稳定 `messageId` 定位并高亮当前会话中的来源消息，不能按预览正文反查来源。
- 用户显式停止生成必须调用 Runtime 取消端点；关闭浏览器连接不等价于取消 Run。
- 已持久化消息不提供删除操作；重新编辑只允许回填输入框并作为新消息提交。桌面使用复制/引用快捷操作，移动端使用单一操作菜单。
- Context Manifest 在桌面使用默认收起的 Inspector，移动端使用 Drawer，避免运行细节长期挤压主对话区。

## 风险与退出路径

- 已知风险：当前 Demo 从无框架页面迁移到 React 会增加构建依赖、包体和升级工作；通过仅迁移渠道层、锁定版本和浏览器回归控制风险。
- 锁定点：组件 API、Ant Design 主题 Token 和 React 构建链；Runtime API、会话数据和 SSE 事件保持框架无关。
- 退出路径：保留 Runtime Adapter 接口，可将 Ant Design X 组件替换为其他实现；服务端数据无需迁移。
- 维护责任：渠道与体验层维护者负责 UI 依赖、Adapter、主题、可访问性和浏览器回归；Runtime 维护者负责取消、引用和事实状态契约。

## 验收与完成报告

- 验证证据：`npm run demo:build` 通过；Adapter 与渠道视图模型 7 项回归覆盖完成、取消、错误、JSON 资源映射、失败提示、输入恢复和发送门禁；全量测试 44/44 通过；浏览器验证桌面 1280x720 与移动端 390x844 无横向溢出、关键操作可访问且控制台无错误。
- 已交付范围：输入、图片与文档链接附件、流式 Markdown、显式取消、当前会话消息引用、引用定位、持久化消息复制、移动端操作菜单、`cancelled/interrupted/failed` 展示、失败输入恢复、网关发送门禁、可收起 Context Inspector 和结构化记忆面板。
- 剩余边界：真正的重试或重新生成仍需要 Runtime 契约，当前恢复入口只创建新草稿；真实上游模型的长回答性能和自动化可访问性审计仍需后续基线；反馈闭环后置；外部信息源引用跟随 C2-C7 对应链路建设；真实阶段事件出现前不展示 ThoughtChain；X SDK 不在当前范围。
- 文档与契约：同步 `docs/scenario-interaction-chains.md`、`openspec/specs/ai-platform/spec.md` 和实现后的 README 使用说明。
- 重评条件：出现多个独立 Web 渠道、Ant Design X 无法满足性能或可访问性要求、现有 SSE Adapter 明显阻碍复用，或正式产品不再采用 Ant Design 体系。

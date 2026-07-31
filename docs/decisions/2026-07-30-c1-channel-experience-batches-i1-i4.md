# C1 渠道体验连续批次 I1-I4

- 状态：接受
- 日期：2026-07-30
- 负责人：AI 应用基础平台维护者
- 所属区域：渠道与体验层 / Agent Runtime
- 关联需求：在已完成 Ant Design X 渠道基线后，连续补齐会话管理、生成恢复、结果消费和体验质量基线
- 关联 OpenSpec：`openspec/specs/ai-platform/spec.md`
- 替代记录：无；扩展 `2026-07-29-c1-channel-experience-ant-design-x.md`

## 问题

当前 C1 已具备多会话、流式 Markdown、停止生成、消息引用、失败恢复、模型选择和运行上下文，但仍偏工程验证：会话数量增加后难以检索和整理，失败或中断后缺少直接重试/重新生成/继续生成，长回答中的代码、表格和标题不够易读，页面也缺少明确的资源预算和可访问性验收。

本次目标是把这些缺口按 I1-I4 连续交付，形成可重复验收的 C1 渠道体验基线。成功证据包括：会话操作由服务端事实收口；恢复动作创建带来源关系的新 Run；Markdown 结果可导航、复制和下载；键盘、移动端、减少动画、长列表和构建资源具有自动化或浏览器证据。

## 约束与非目标

### 必须满足

- SQLite 继续拥有 Conversation、Message 和 Run 事实；浏览器搜索、筛选和草稿不能成为第二事实源。
- 所有重新生成、重试和继续生成都创建新的幂等 Run，不修改或删除历史消息。
- 渠道只展示真实 Run 状态，不伪造模型思维链或服务端不存在的阶段。
- 继续使用已锁定的 Ant Design X、X Markdown、Ant Design 和现有 Runtime Adapter，不引入第二套消息协议。
- 会话归档与生命周期关闭保持独立；取消归档不等于重新打开已关闭会话。

### 本次不解决

- 不实现记忆纠正/遗忘、点赞点踩及反馈评测闭环（I5）。
- 不实现鉴权、租户、配额、分享、真实文件资产、文档检索或其他场景产品化能力（I6）。
- 不删除持久化会话或消息，不建立对话分支树。
- 不实现 Token 级断点续传或回答 checkpoint。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| Ant Design X 组件 + 现有 Runtime Adapter | 轻量可组合 | `Conversations` 分组/菜单、`Actions`、`Bubble`、X Markdown 与现有 API | 复用当前依赖和事实边界；无需数据迁移或第二套协议 | 会话更新和 Run 来源关系仍需平台稳定契约 | `2026-07-29-c1-channel-experience-ant-design-x.md`、当前 `demo/src/App.jsx` |
| AI SDK UI / AI Elements 全量迁移 | 成熟一体化 | 消息状态、重新生成和结果组件 | Web AI 交互组件丰富 | 要替换当前 POST SSE Adapter 和消息映射，不能减少 Runtime 核心复杂度 | 既有渠道体验决策中的候选验证 |
| 继续逐项自研静态交互 | 最小自研 | 在当前页面局部增加菜单和样式 | 单项改动小 | 容易形成无契约的零散行为，长期追赶通用交互与可访问性 | 当前体验缺口盘点 |

## 淘汰条件

- 让浏览器修改历史消息、伪造 Run 最终状态或绕过 Agent Runtime 调用模型。
- 为重试或重新生成复用旧 `requestId`/`clientMessageId`，造成幂等重放而非新结果。
- 把归档实现为删除，或把取消归档实现为重新打开 closed 会话。
- 用包体阈值隐藏构建问题，或者仅凭视觉截图宣称可访问性完成。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 现有 `Conversations` 支持分组和操作菜单 | 检查锁定版本类型与运行组件 | `@ant-design/x@2.9.0` | 通过；支持 `groupable`、`menu` 和稳定 key | `node_modules/@ant-design/x/es/conversations` |
| 新恢复动作可以复用现有 Run 主链 | 为新 Run 增加来源 Run 和恢复模式，继续走同一 POST SSE | 当前 Runtime/Store/Adapter | 通过；Runtime 与真实 HTTP 均验证来源状态和新 Run 关系，浏览器 regenerate 保留草稿 | `scripts/test-runtime.mjs`、`scripts/test-streaming-http.mjs` |
| X Markdown 可在不替换解析器时增强结果消费 | 使用组件映射、安全链接和渠道操作 | `@ant-design/x-markdown@2.9.0` | 通过；浏览器真实回答验证标题锚点、代码复制、表格和 `noopener noreferrer` 外链 | `demo/src/App.jsx`、`scripts/test-demo-adapter.mjs` |
| 资源拆分与长列表窗口能降低首次和持续渲染压力 | 构建预算脚本、长列表视图模型和浏览器检查 | Vite 6.4.3 | 通过；JS gzip 总量 381.21 KiB，CSS gzip 总量 5.87 KiB，桌面与 390px 无横向溢出，移动主要按钮不小于 44px | `demo/vite.config.mjs`、`scripts/check-demo-build.mjs` |

## 决策

- 结论：适配。
- 选择方案：Ant Design X/X Markdown 2.9.0 + Ant Design 6.5.2 + 现有 Runtime Adapter。
- 决策依据：当前依赖已经覆盖所需通用交互，平台只需补齐数据所有权、恢复来源、渠道适配和质量门禁，无需迁移主链或引入新框架。
- 平台拥有：Conversation 更新与归档契约、Run 恢复来源、事实同步、渠道草稿边界、错误语义、构建预算和验收脚本。
- 外部方案负责：会话列表、菜单、输入、消息操作、Markdown 解析净化和基础可访问性交互。
- 明确不实现：第二套会话事实源、对话分支、原始思维链、反馈闭环和多人产品化能力。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| AI SDK UI / AI Elements 全量迁移 | 当前 Runtime 已有独立 JSON/POST SSE/事实 SSE 契约，迁移不能减少服务端状态复杂度 | 多个 Web 渠道统一要求 AI SDK UI 协议，且迁移可保留当前事实源和恢复语义 |
| 继续零散自研 | 无法形成批次验收、稳定恢复语义和长期资源预算 | Ant Design X 无法满足必要交互或出现不可接受的兼容问题 |

## 实施边界

- I1：服务端支持标题和归档状态更新；搜索、时间分组、筛选和 session 级草稿由渠道拥有。
- I2：`sourceRunId + recoveryMode` 仅记录新 Run 的来源与意图；新输入仍按普通 Run 校验和持久化，历史事实不可变。
- I3：代码复制、标题导航、安全外链和 Markdown 下载只作用于渠道展示，不改变模型输出正文。
- I4：长列表使用渐进窗口，构建使用显式 vendor 分块和 gzip 预算；不自研虚拟列表框架。
- 关闭会话仍是不可逆业务生命周期；归档只影响渠道整理和默认可见性。

## 风险与退出路径

- 已知风险：恢复动作不是分支，会在当前会话末尾创建新轮次；UI 必须明确新 Run 语义。
- 锁定点：Ant Design X 会话菜单、X Markdown 组件映射、Run 来源字段。
- 退出路径：渠道增强可通过 Adapter 替换；Conversation/Run 数据仍为框架无关 SQLite 事实。
- 维护责任：渠道与体验层维护交互、可访问性和资源预算；Runtime 维护会话更新、恢复来源和幂等边界。

## 验收与完成报告

- 验证证据：Runtime、GatewayClient、天气 Connector、Demo Adapter、真实 POST SSE 等全量测试 71/71 通过；构建预算、桌面/390px 浏览器链路和 OpenSpec strict 校验均通过。内置浏览器可见下载菜单和 Blob 命令，但未回传文件下载事件，实际文件落盘仍需在普通浏览器人工复核。
- 剩余边界：I5 记忆控制/反馈闭环和 I6 产品化能力明确延期。
- 文档与契约：同步 `README.md`、`docs/decisions/README.md`、`docs/scenario-interaction-chains.md` 和稳定 OpenSpec。
- 重评条件：出现对话分支需求、多 Web 渠道统一协议、会话规模超过渐进窗口能力，或 Ant Design X/X Markdown 无法满足性能与可访问性目标。

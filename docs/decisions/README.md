# 方案决策记录

本目录保存平台能力的方案发现、验证和选择证据。记录用于回答“为什么这样选”和“为什么没有使用其他方案”，不能只描述最终实现。

## 使用方式

1. 从 [`TEMPLATE.md`](./TEMPLATE.md) 复制一份新记录。
2. 文件名使用 `YYYY-MM-DD-<简短英文主题>.md`。
3. 正式实现前把状态从“提议”更新为“接受”。
4. 决策变化时新建记录，并在新旧记录中注明替代关系；不删除历史记录。
5. 如果最终选择改变稳定行为、接口、配置或安全边界，继续按 OpenSpec 流程更新契约。

## 状态

| 状态 | 含义 |
| --- | --- |
| 提议 | 正在调研或验证，不能进入正式实现 |
| 接受 | 证据和边界已经确认，可以按记录实施 |
| 拒绝 | 候选或提议不采用，保留原因供后续检索 |
| 已替代 | 后续决策已经替代本记录，但历史依据仍保留 |

## 已有记录

| 日期 | 记录 | 状态 | 结论摘要 |
| --- | --- | --- | --- |
| 2026-08-15 | [Runtime 智能操作路由采用会话上下文快照与可验证模型证据](./2026-08-15-runtime-context-aware-operation-routing.md) | 接受 | 从 Message/Run/image_asset 不可变事实派生活动图片，以有界 routing snapshot 驱动结构化分类；Runtime 校验证据、选择源图并持久化脱敏 intentDecision，确定性链路与真实模型识别分开评测 |
| 2026-08-13 | [Runtime 生命周期事件端口与渠道交付解耦](./2026-08-13-runtime-event-port-and-delivery.md) | 接受 | 以项目自有 `RunEventSink` 发布易失生命周期事件，Demo Server Adapter 映射 SSE；订阅失败不反向污染执行事实，SQLite 事件继续作为可恢复历史 |
| 2026-08-13 | [Runtime 执行治理基础](./2026-08-13-execution-governance-foundation.md) | 接受 | 以版本化 ExecutionPolicy、Operation journal 和 SQLite RunLease/fencing 建立执行治理边界；写操作确认、业务回读和补偿仍未完成 |
| 2026-08-13 | [首期可恢复执行与独立结果验收](./2026-08-13-durable-run-recovery-and-acceptance.md) | 接受 | 复用 SQLite Run + ToolCall 恢复 completed 只读 ToolResult 后的最终总结，并以持久化 AcceptanceResult 阻断缺少事实证据的天气回答；复杂生命周期再重评成熟引擎 |
| 2026-08-02 | [Runtime 智能默认操作路由采用结构化意图分类](./2026-08-02-runtime-smart-operation-routing.md) | 已替代 | 首版当前附件候选矩阵与结构化分类保留为历史依据；会话活动图片、历史证据与路由审计由 2026-08-15 决策替代 |
| 2026-08-02 | [Runtime 使用 LiteLLM Virtual Key 的模型映射边界](./2026-08-02-runtime-virtual-key-mapping.md) | 接受 | 运维预配受限 virtual key，Runtime 只消费最小权限 key；模型目录、计数、生成和 spend 使用同一身份 |
| 2026-08-01 | [LiteLLM 网关治理专项 PoC](./2026-08-01-litellm-governance-poc.md) | 接受 | 固定 LiteLLM `1.89.1` + 独立 PostgreSQL 已验证 virtual key、预算硬拒绝、真实 spend 与 team 累计；Runtime 不重复实现网关预算和限流 |
| 2026-08-02 | [C2 多轮图片编辑采用 Responses 图片工具路径](./2026-08-02-c2-multi-turn-image-editing-responses-path.md) | 接受 | `image.edit` 改用 Responses `image_generation(action=edit)`；本地资产继续作为每轮事实源，2026-08-15 当前配置已通过两轮真实编辑 smoke |
| 2026-07-31 | [C2 图生图采用 AI SDK 图片编辑路径](./2026-07-31-c2-image-editing-ai-sdk-path.md) | 已替代 | `/images/edits` 协议与资产边界保留为历史证据，主路径由 2026-08-02 Responses 决策替代 |
| 2026-07-31 | [C2 图片理解与生成能力边界](./2026-07-31-c2-image-understanding-and-generation-boundary.md) | 接受 | C1 保持会话入口，C2 统一承载图片理解与生成并复用 `image_asset`，但使用独立操作契约；具体图片模型、存储与审核方案继续通过 PoC 选型 |
| 2026-07-31 | [ToolResult 持久化总结恢复](./2026-07-31-tool-result-summary-recovery.md) | 接受 | 工具后模型瞬时失败且尚未交付正文时，从 SQLite ToolResult 构造 AI SDK 结构化消息做无工具恢复；不重复 Connector，也不建设工作流引擎 |
| 2026-07-31 | [AI SDK Core v7 调用边界对齐](./2026-07-31-ai-sdk-core-v7-alignment.md) | 接受 | 工具型对话复用 `ToolLoopAgent` 并按 Run 动态配置；普通调用和动态结构化输出保留 Core 函数路径，同时停止依赖 v7 弃用结果字段 |
| 2026-07-30 | [V1 只读工具循环与天气 Connector](./2026-07-30-v1-read-only-tool-loop-and-weather.md) | 接受 | 固定 LiteLLM digest；以 Open-Meteo 跑通首个无副作用只读工具，并由后续 Core v7 决策细化 Agent 复用和调用分流边界 |
| 2026-07-30 | [C1 渠道体验连续批次 I1-I4](./2026-07-30-c1-channel-experience-batches-i1-i4.md) | 接受 | 继续适配 Ant Design X 与现有 Runtime Adapter，连续补齐会话管理、Run 恢复、结果消费和体验质量基线；I5/I6 明确延期 |
| 2026-07-30 | [C1 ChainTrace 运行态验收延期](./2026-07-30-c1-chaintrace-runtime-validation-deferral.md) | 接受 | 保留默认关闭的技术接入和 Phoenix 选型；正式实例、真实 Runtime Trace 与四维运行态基线转为触发式 TODO |
| 2026-07-30 | [C1 ChainTrace 最终后端采用 Phoenix](./2026-07-30-c1-chaintrace-backend-phoenix.md) | 接受 | 采用 Phoenix 19.10.0 + PostgreSQL 17；保留后端中立 OTLP/ChainTracer，并以 Auth、精确检索和升级回滚实测为门禁 |
| 2026-07-30 | [C1 ChainTrace 后端对比](./2026-07-30-c1-chaintrace-backend-comparison.md) | 接受 | 同一脱敏 C1 OTLP Trace 完成 Langfuse/Phoenix 的查询、隐私、部署、权限、保留和资源实测，Phoenix 进入最终决策 |
| 2026-07-29 | [C1 渠道体验采用 Ant Design X](./2026-07-29-c1-channel-experience-ant-design-x.md) | 接受 | 适配 Ant Design X 与 X Markdown，保留现有 Runtime/SSE 事实边界，并先固化取消和分类型引用契约 |
| 2026-07-29 | [C1 ChainTrace 优先级与 OpenTelemetry 实施路径](./2026-07-29-c1-chaintrace-priority-and-otel-path.md) | 已替代 | OTel PoC 与后端决策路径已执行；“运行态验收优先于后续建设”的门禁由延期记录替代 |
| 2026-07-29 | [存量能力选型审计](./2026-07-29-existing-capability-selection-audit.md) | 接受 | 保留模型主链和业务事实；封装记忆与有限重试；迁移到 OTel；停止自研工具循环、协议、工作流引擎和 Trace 后端 |

没有单独决策证据的存量实现仍按照 [`方案选型与复用治理`](../solution-selection-governance.md) 审计，不能因为本次总审计存在就自动视为已经通过选型。后续 PoC、迁移和重要依赖引入继续建立独立记录。

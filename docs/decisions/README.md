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
| 2026-07-30 | [C1 ChainTrace 运行态验收延期](./2026-07-30-c1-chaintrace-runtime-validation-deferral.md) | 接受 | 保留默认关闭的技术接入和 Phoenix 选型；正式实例、真实 Runtime Trace 与四维运行态基线转为触发式 TODO |
| 2026-07-30 | [C1 ChainTrace 最终后端采用 Phoenix](./2026-07-30-c1-chaintrace-backend-phoenix.md) | 接受 | 采用 Phoenix 19.10.0 + PostgreSQL 17；保留后端中立 OTLP/ChainTracer，并以 Auth、精确检索和升级回滚实测为门禁 |
| 2026-07-30 | [C1 ChainTrace 后端对比](./2026-07-30-c1-chaintrace-backend-comparison.md) | 接受 | 同一脱敏 C1 OTLP Trace 完成 Langfuse/Phoenix 的查询、隐私、部署、权限、保留和资源实测，Phoenix 进入最终决策 |
| 2026-07-29 | [C1 渠道体验采用 Ant Design X](./2026-07-29-c1-channel-experience-ant-design-x.md) | 接受 | 适配 Ant Design X 与 X Markdown，保留现有 Runtime/SSE 事实边界，并先固化取消和分类型引用契约 |
| 2026-07-29 | [C1 ChainTrace 优先级与 OpenTelemetry 实施路径](./2026-07-29-c1-chaintrace-priority-and-otel-path.md) | 已替代 | OTel PoC 与后端决策路径已执行；“运行态验收优先于后续建设”的门禁由延期记录替代 |
| 2026-07-29 | [存量能力选型审计](./2026-07-29-existing-capability-selection-audit.md) | 接受 | 保留模型主链和业务事实；封装记忆与有限重试；迁移到 OTel；停止自研工具循环、协议、工作流引擎和 Trace 后端 |

没有单独决策证据的存量实现仍按照 [`方案选型与复用治理`](../solution-selection-governance.md) 审计，不能因为本次总审计存在就自动视为已经通过选型。后续 PoC、迁移和重要依赖引入继续建立独立记录。

# 项目文档

这个目录承接项目结构、架构说明和运维边界。`AGENTS.md` 只保留 AI 协作入口和路由，详细说明放在这里。

## 文档索引

- [Mastra 完整 PM Skills](../practices/mastra/.agents/skills/README.md)：111项上游能力、中文入口、来源锁、MIT、原生加载与维护；[适配决策](./decisions/2026-11-06-mastra-pm-skills.md)。

- [应用实践集合](../practices/README.md)：与探索实现并行，按 Mastra、pi 等项目的原生方式学习应用；共用业务与验收问题，不强制统一运行时。
- [Mastra 原生最小应用与产研交接](../practices/mastra/README.md)：独立启动、Agent/工具、Studio/API、四阶段提案确认和暂停后跨进程恢复的实测证据；区分固定模型验证与真实工程交付。
- [Mastra 产品固定角色子流程](../practices/mastra/product-workflow.md)：四个产品 Agent 的职责、人工批准、返工来源与版本契约；真实质量收益另行验证。
- [Mastra 产品 Skill 配对评测](../practices/mastra/evaluations/product-skills/README.md)：固定模型、角色、流程和输入，切换 Skill；记录用量与耗时，人工填写遗漏、首次通过和审阅时间。
- [探索与原生应用实践分开组织](./decisions/2026-11-02-exploration-and-native-practices.md)：记录两条学习方向、规则作用域、原生比较方法与现有实验归属；不代表接受任何框架迁移。
- [AI 应用基础平台架构说明](./ai-structure.md)：六个架构区域、控制面/数据面、当前代码映射、可插拔契约、数据所有权、独立服务拆分蓝图，以及 V0-V4 实施对比。
- [AI SDK Core v7 对齐说明](./ai-sdk-core-alignment.md)：说明当前采用的 Core 原语、GatewayClient 适配边界、v7 结果语义和按场景延后的能力。
- [场景化输入到大模型交互链路](./scenario-interaction-chains.md)：明确共同底座、只读工具切片、分阶段重试与恢复边界，按对话、图片、文档、业务数据、实时事件、操作执行和批量分析拆分端到端链路，并固化当前 C1 焦点及四维验收框架。
- [运行可靠性与结果验收](./runtime-reliability-and-acceptance.md)：用 R0-R4 与 A0-A4 分开表达可执行、可记录、可重放、可恢复、多实例协调，以及模型声明、结构校验、事实绑定、系统验收和人工确认；记录当前 Operation journal、RunLease/fencing 基础、天气恢复点与 Scenario Runner 扩展方式。
- [C1 对话链路深入理解指南](./c1-conversation-chain-learning-guide.md)：不依赖源码阅读，通过贯穿案例解释 C1 的参与者、状态、上下文、记忆、幂等、重试、流式交付、取消、观测和评测。
- [C1 链路深挖问题清单](./c1-conversation-chain-deep-dive-questions.md)：以问题驱动方式追问每项能力的业务动机、约束、候选、采用/适配/自研边界、验证证据和重评条件。
- [C1 ChainTrace 运维说明](./c1-chaintrace-operations.md)：保留为触发 TODO 后的 Phoenix + PostgreSQL 启用手册，说明认证、Runtime OTLP 配置、健康检查、备份和升级回滚边界；当前日常启动不执行。
- [方案选型与复用治理](./solution-selection-governance.md)：约束方案发现、成熟能力复用、`采用 / 适配 / 自研` 决策、存量能力审计和能力完成报告。
- [方案决策记录](./decisions/README.md)：保存每次能力选择、未采用原因、验证证据、退出路径和重评条件，并提供统一模板。
- [pi Agent Runtime 隔离对比](./decisions/2026-10-13-pi-agent-isolated-comparison.md)：两套真实 SDK 的确定性工具、故障和进程恢复对比，以及 Node 24 验证记录。
- [pi 后续选型验证](./audits/2026-10-13-pi-followup-verification.md)：46 项 PoC、durable 故障边界、迁移删除清单、许可声明和真实模型门禁。
- [架构与方案决策存量审计（2026-10-12）](./audits/2026-10-12-architecture-decisions.md)：按最新 ADR Skill 审计 21 份决策，区分契约偏差、历史演进、证据与交接缺口。
- [决策审计修复验证与证据登记](./audits/2026-10-12-decision-repair-evidence.md)：记录契约同步、18 份有效决策补齐、165 项回归与仍需真实验证的门禁。
- [编码规范](./coding-standards.md)：函数注释、数据结构、设计模式、设计原则和变更检查要求。
- [架构图视觉与表达规范](./architecture-diagram-style.md)：统一当前项目架构图的模块框、关联箭头、职责边界、状态标识、路径摘要和 SVG/PNG 资产要求。
- [上下文管理](./context-management.md)：持久化会话、结构化记忆、Context Planner、高低水位、并发控制和 100 轮评测。
- [Agent Skills 索引](../.agents/skills/README.md)：本项目 Skill 目录规范、索引和治理要求。
- [架构与方案决策 Skill](../.agents/skills/docs/architecture-decision/SKILL.md)：架构决策记录的 Agent-first 工作流，以及与选型治理和 OpenSpec 的边界。

## 与 OpenSpec 的分工

- `docs/` 解释项目如何工作、为什么这样分层、后续怎么演进。
- `.agents/skills/` 承接可复用的 Agent Skill、目录规范和治理口径。
- `openspec/` 固化稳定能力契约，约束后续代码和配置变更。
- `README.md` 保持用户启动和测试路径清晰，不承载过多内部协作细节。

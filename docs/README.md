# 项目文档

- [Mastra长时间执行与处理交互](../practices/mastra/execution-status-interaction.md)：超时层次、自动重试、上下文整理、未知态和失败恢复；已接入产品尝试、失败来源、只读配置和受限取消；上下文细分事件与在线参数调整仍为后续设计。

- [Mastra 业务验收改造设计](../practices/mastra/business-delivery-design.md)：澄清预算续办、最终包独立审查、纵向旅程、全栈执行及测试扩展，包含实施批次与20项验收；设计稿，尚未生效。

- [Mastra本机交付闭环示例](../practices/mastra/examples/local-delivery/README.md)：工单标题校验、真实沙箱/浏览器、本机发布健康与故障回滚；固定模型不代表真实业务验收。

- [Mastra 自主开发与修复闭环](./decisions/2026-11-09-mastra-autonomous-development.md)：批准范围内连续实现、登记检查、失败证据传递、联合修复与预算/进展停止；[使用说明](../practices/mastra/unified-workflow.md#批准范围内自主开发与排障)。

- [开发阶段状态与故障引导](./decisions/2026-11-08-mastra-stage-state-flow.md)：当前阶段、故障原因、保留检查点和下一步操作；未执行业务节点不再空跑为完成，原阶段暂停恢复。

- [HRM 全栈验证与开发自主规划](./decisions/2026-11-08-mastra-hrm-execution.md)：用户确认关联项目，Agent 提出具体文件与团队；已实测 Docker 中类型检查、构建及页面/API/临时数据库连通。[使用说明](../practices/mastra/README.md)。

- [Mastra资源配置接入规范](../practices/mastra/config/runtime-resource-contract.md)：原始设计，预算统一、最小DTO和资料快照仍待实施。[角色原生版本运行说明](../practices/mastra/config/stored-role-runtime.md)：已接入正式主流程的Agent/Skill版本、Run绑定、资源发布及可信制品核验，不兼容历史Run。[前置四项实验](../practices/mastra/evaluations/native/stored-role-validation.md)与正式入口回归分别记录。

- [HRM 产物归档与数据流转](../practices/mastra/artifact-dataflow.md)：项目/迭代/Run 关联、阶段版本、查看与下载；[PNG](./assets/mastra-hrm-artifact-dataflow.png) / [SVG](./assets/mastra-hrm-artifact-dataflow.svg)，[决策](./decisions/2026-11-07-hrm-asset-catalog.md)。

- [HRM 仓库资产归属](./decisions/2026-11-07-hrm-repository-assets.md)：产品、测试、发布投影归 hrm，业务资料从 product/sources 读取；全栈验证见2026-11-08决策，源码回库已按[新决策](./decisions/2026-11-09-mastra-code-publication.md)接通，真实业务远端验收待执行。

- [Mastra 完整产研流程](../practices/mastra/unified-workflow.md)：同一主 Run，工作台承接人工关口，Studio 用于调试，产品到动态团队、前后端并行/受限委派、评审、独立测试/缺陷回归、外部发布回执/健康与回滚、最终交付；[生命周期决策](./decisions/2026-11-07-mastra-full-delivery-lifecycle.md)，[统一团队选型](./decisions/2026-11-07-mastra-unified-development-team.md)。下文旧双流程与图保留为历史设计。

- [Mastra 工作流中的局部 ReAct 自闭环 SVG](./assets/mastra-workflow-local-react-loops-v1.svg) / [PNG](./assets/mastra-workflow-local-react-loops-v1.png)：说明产品、开发、测试三类团队的受限推理—行动—观察循环，以及 Workflow 与人工门禁的边界。

- [Mastra 当前原生产研实践能力图 SVG](./assets/mastra-current-capability-map-v1.svg) / [PNG](./assets/mastra-current-capability-map-v1.png)：总览工作台、固定 Workflow、受控多角色团队、事实/资料/隔离执行、评测与人工治理，并将 MCP、向量 RAG、自动 CI/CD 等未接入或待验收能力显式区分。

- [Mastra六类开发独立节点评测](../practices/mastra/evaluations/native/development-nodes/README.md)：上下文、架构、就绪、实现、自检、代码评审的18例冻结数据集，原生Workflow/Experiment及真实代码证据。

这个目录承接项目结构、架构说明和运维边界。`AGENTS.md` 只保留 AI 协作入口和路由，详细说明放在这里。

## 文档索引

- [Mastra 完整 PM Skills](../practices/mastra/.agents/skills/README.md)：111项上游能力、中文入口、来源锁、MIT、原生加载与维护；[适配决策](./decisions/2026-11-06-mastra-pm-skills.md)。

- [应用实践集合](../practices/README.md)：与探索实现并行，按 Mastra、pi 等项目的原生方式学习应用；共用业务与验收问题，不强制统一运行时。
- [Mastra 招聘 Workspace 与资料评测](../practices/mastra/workspaces.md)：业务资料只读挂载、运行产物导出和固定来源评测。
- [Mastra 原生最小应用与产研交接](../practices/mastra/README.md)：当前启动、产研工作台、模型配置与执行边界；历史提案链和验证计数单独归档。
- [Mastra 产品固定角色子流程](../practices/mastra/product-workflow.md)：四个产品 Agent 的职责、人工批准、返工来源与版本契约；真实质量收益另行验证。
- [Mastra 研发阶段工作流](../practices/mastra/development-workflow-design.md)：技术方案确认、受限实现、开发自检、返工和研发交付；[24案例评测](../practices/mastra/evaluations/development/README.md)区分离线执行、真实模型和人工量表，[首轮 pilot 观察](../practices/mastra/evaluations/development/observations-2026-11-06.md)记录原始结果、发现的问题与未准入结论；[续办记录](../practices/mastra/evaluations/development/continuation-2026-11-06.md)保留当时的恢复修复、评测结果、全栈候选与环境阻塞；当前独立测试已接入完整主链。
- [Mastra BMAD 工作流融合设计](../practices/mastra/bmad-workflow-integration.md)：旧双 Workflow/CLI 交接的历史设计，任务包、就绪、评审及交付门已演进至当前主链；[运行图 PNG](./assets/mastra-bmad-workflow-v2.png) / [SVG](./assets/mastra-bmad-workflow-v2.svg)；[选型记录](./decisions/2026-11-06-mastra-bmad-method-integration.md)。
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

- [Mastra 主流程需求输入](../practices/mastra/guided-intake.md)：需求澄清、开发阻塞后的业务选择补齐、完整修订稿确认及开发、测试、发布等人工关口。

- [Mastra 角色产物远端交接与按需上下文](./decisions/2026-11-08-mastra-remote-handoff.md)：阶段同步回执、原生同步恢复与有界资料读取。

- [Mastra 项目运行档案](../practices/mastra/artifact-dataflow.md#2026-11-09项目运行档案)：生命周期投影、交接分支同步与只读 Workspace，不迁移执行状态。

- [Mastra 浏览器 QA](../practices/mastra/browser-qa.md)：Skill、原生 Agent、Playwright 工具与 Workflow 质量门；[选型 ADR](./decisions/2026-11-09-mastra-gstack-browser-qa.md)，首版静态候选，HRM 全栈仍阻塞。

- [Mastra 开发独立评测与源码回库（2026-11-09）](../practices/mastra/evaluations/native/development-nodes/results-2026-11-09.md)：真实模型分角色结果、原始实验和 Git 回库验证边界。

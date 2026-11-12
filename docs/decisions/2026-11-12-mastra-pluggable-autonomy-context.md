# 将 Mastra 产研自主 loop 与共享上下文适配为可插拔策略

- 状态：接受
- 日期：2026-11-12
- 负责人：Mastra 实践维护者
- 所属区域：独立应用实践
- 关联需求：在不引入第二个 Agent Runtime、不过度共享会话或放宽执行权限的前提下，增强自主排障 loop 的可替换性和角色间上下文边界。
- 关联 OpenSpec：不涉及探索主线稳定契约；仅变更 `practices/mastra/` 的内部适配和实践说明。
- 替代记录：无；细化 [批准范围内自主开发与修复闭环](./2026-11-09-mastra-autonomous-development.md) 与 [Mastra 原生上下文管理](./2026-11-09-mastra-native-context.md)。

## 问题

当前 Mastra 产研流程已经有批准范围、受限委派、登记检查、独立评审和有界返工，但自主 loop 的失败归因直接固化在返工模块中；角色间共享的对象也容易被误解为“共享全部 session”。这会使后续增加更细的诊断策略、项目级经验规则或跨阶段交接时，要么改动核心 loop，要么把 Agent 的临时对话和观察记忆误当作项目事实。

成功证据是：返工仍仅依据已持久化检查/评审事实；可替换策略不能得到执行器、模型 prompt、凭据或扩大权限的入口；上下文共享只能传递有来源、哈希、受众和用途的引用；原有自主开发回归保持通过。

## 约束与非目标

### 必须满足

- Mastra Workflow/LibSQLStore 继续是 Run、审批、暂停和恢复的唯一事实源。
- 已批准的文件、角色、命令、预算、检查和人工关口不因策略替换而扩大。
- 每次角色调用的原生 Observational Memory 继续独立 thread/resource；不跨角色或跨 Run 复用失败消息和私有观察。
- 配置与策略版本必须显式；无效策略失败关闭。

### 本次不解决

- 不引入 Tutti 或第二套多 Agent Runtime、持久化层、Inbox、Cron 或跨渠道身份系统。
- 不自动从历史 Run 生成或发布 Skill、提示词、权限或策略；经验沉淀仍需人工审核与评测。
- 不新增真正跨项目的用户画像、长期语义记忆或生产多实例协调。
- 不改变探索主线 Runtime 的 Session/Run 规范。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| Tutti 作为主编排运行时 | 成熟一体化 | 多 Agent、session/memory、工具、审批与事件 | 内聚的 Agentic loop 与多渠道能力 | 将与 Mastra Store/Workflow、冻结角色资源、审批和交付事实形成双运行时；需迁移既有恢复及受控执行边界 | Tutti 官网及本次能力对照；当前 [Mastra 主流程](../../practices/mastra/unified-workflow.md) |
| 保留 Mastra，适配小型策略 Port | 轻量可组合 | loop 归因与共享上下文选择 | 复用原生 Workflow、Store、Memory 与既有执行 Adapter；变更面小 | 策略注册、项目化经验库和真实模型质量仍需后续验收 | 当前 `autonomy.ts`、角色 DTO、已有自主开发决策 |
| 自建通用 Agent/记忆/编排引擎 | 最小自研 | 调度、会话、记忆、工具权限、恢复 | 表面上可完全定制 | 重复框架的持久化、并发、恢复和观测能力，长期维护边界过大 | [方案治理](../solution-selection-governance.md) 的自研准入条件 |

## 淘汰条件

- 候选如果让完整 Agent 对话、思维过程或观察记忆成为审批/交付事实，即淘汰。
- 候选如果能通过策略直接添加 shell、依赖、文件路径、角色或发布权限，即淘汰。
- 候选如果产生与 Mastra Store 并列的 Run/审批事实源，或无法绑定冻结资源版本，即淘汰。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 自主归因可解耦而不改变预算/停止语义 | 抽出纯 `LoopPolicy`，以既有真实 Workflow 自主回归验证 | Node 24.19.0、Mastra 锁定依赖 | 通过 | `tests/autonomy-extension-policies.test.ts`、`tests/development-autonomy.test.ts` |
| 共享边界可拒绝全量 session 与私有字段 | `ContextSharePolicy` 仅接受严格 schema 的哈希引用，验证受众筛选、去重和未知字段拒绝 | `context-share-policy.v1` | 通过 | `tests/autonomy-extension-policies.test.ts` |
| 类型边界未漂移 | TypeScript 严格检查 | 当前锁文件 | 通过 | `npm run check` |

## 决策

- 结论：**适配**。
- 选择方案：保留 Mastra 原生 Workflow、LibSQLStore 和 Observational Memory；在 `development/v2` 中添加同步、纯函数、版本化的 `LoopPolicy` 和 `ContextSharePolicy` 边界。
- 决策依据：现有主流程已有受控执行、审批、恢复和最小角色 DTO；当前缺口是可替换的策略面，而不是新的调度器。Tutti 值得借鉴的是预算化/权限化 loop 与分层 memory，而不是替换本实践的事实源。
- 平台拥有：失败归因策略接口、共享事实引用 schema、版本校验、策略的测试与后续准入治理。
- 外部方案负责：Mastra 继续负责 Agent、Workflow、工具循环、Store 和原生 Memory；Tutti 未被引入。
- 明确不实现：完整 session 广播、跨 Agent 私有记忆共享、自动策略自修改、自由路由网络与新通用编排引擎。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| Tutti 直接接管产研主流程 | 不能在不重复 Run/审批/恢复事实的前提下取代当前 Workflow；也会扩展多渠道与身份范围 | Mastra 无法满足持久化协作/权限审批且能完成可迁移 PoC 时 |
| 共享整个 Session 或所有 Agent Memory | 会泄露角色私有临时推理，且无法成为可审计事实 | 已建立身份、租户、数据分级和跨渠道授权模型时 |
| 自研通用框架 | 违反成熟能力复用优先，且不满足小而稳定的自研准入 | 现有框架无法提供必须的恢复/隔离语义且稳定 Adapter 不可行时 |

## 实施边界

- `LoopPolicy` 只读输入是当前 `StateV2` 与已脱敏、已持久化的检查失败摘要；只能返回既有的 `code/environment/business/authorization` 分类。它不接触 `ExecutionPort`、模型、文件系统或配置凭据。
- `ContextSharePolicy` 只选择 `SharedContextRef`，每条引用强制带 `id/hash/source/audience/purpose`；正文仍由冻结的资料、审批产物和既有最小角色 DTO 按需读取。
- 默认策略采用最小权限：未知故障按受控代码返工处理；无受众授权的引用不交付。无效版本/实现立即拒绝。
- 策略扩展的正式注册、按 Run 冻结和管理界面仍是后续工作；在此之前默认策略是唯一生产行为，不能将导出的接口描述为已开放动态插件市场。

## 实施计划

- 受影响路径：`practices/mastra/src/development/v2/loop-policy.ts`、`context-share-policy.ts`、`autonomy.ts` 与对应测试、`unified-workflow.md`、本决策及索引。
- 核心数据结构：`RepairKind` 为固定枚举；`SharedContextRef` 是不可变 DTO，哈希为 SHA-256 十六进制、受众/用途是有界枚举；不保存正文或 Agent private memory。
- 遵循的模式：策略模式隔离归因与选择；DTO/Adapter 模式维持最小跨角色投影；Workflow/Store 继续拥有状态与持久化。
- 设计原则：单一职责（策略不执行 I/O）、最小权限、依赖倒置（`autonomy.ts` 依赖 `LoopPolicy` 接口）、KISS（无新服务/数据库）。

## 验收与完成报告

- [x] 默认 loop 归因仍覆盖环境与代码失败，且无效策略失败关闭。
- [x] 共享引用按受众筛选、稳定去重，拒绝未知字段和空受众。
- [x] 已运行专项与既有自主开发回归，15/15 通过。
- [x] 已通过 `npm run check`。
- [x] 文档说明未把策略 Port 描述成动态运行时插件或真实模型质量结论。
- [ ] 后续用真实模型 HRM 任务评测策略是否降低无效返工、成本和人工介入；固定模型/脚本回归不代表该结论。

## 风险、退出与重评

策略错误归类可能增加无效返工，因此默认策略保持保守并受原有预算、无进展和人工升级门限制。可通过不注入非默认策略回退到 `loop-policy.v1` / `context-share-policy.v1`；历史 Run 不改写。维护责任归 Mastra 实践维护者。

当需要跨渠道身份会话、跨项目长记忆、动态策略发布、工具级逐次审批或生产多实例恢复时，必须先建立独立决策与 PoC，明确身份、授权、数据留存、版本冻结、审计和退出路径。

## 与 Tutti 的二次对照（2026-11-12）

本次以 Tutti 的 Agent、session/memory、工具权限、预算、checkpoint 和事件化编排思想作设计对照；不是引入或替代 Tutti 的实施结论。对照关注“它解决的运行问题”而不是 API 名称。

| Tutti 思想 | 当前 Mastra 实践状态 | 本次处理 | 后续采用门槛 |
| --- | --- | --- | --- |
| Agent loop 的 turns、工具调用与费用/时间预算 | 已有模型调用、检查、返工、超时及无进展上限，但尚未形成统一可视化成本账本 | 保留既有预算门禁；不创建重复调度器 | 要先定义 token/费用事实来源、阶段配额、告警及真实模型成本评测 |
| 编排与 specialist 的声明式能力边界 | 已有冻结角色资源、动态团队、深度 1 受限委派和最小 DTO | 继续保留；不采用自由 Agent network 路由 | 角色数量/项目类型增长后，以版本化 capability manifest PoC 验证可读性与恢复一致性 |
| session、用户记忆及跨渠道连续性 | 当前每次角色调用独立原生 Memory；Run/审批事实由 Store 持有 | 新增最小 `SharedContextRef` 策略边界，拒绝全量 session 共享 | 必须先有已认证 identity、租户隔离、同意/删除、数据分级和跨渠道授权模型 |
| checkpoint、interrupt 与 durable 恢复 | Mastra 原生暂停/恢复、冻结资源、源码散列、检查点和重试已有 | 不替换事实源 | 若出现多实例接管或外部副作用恢复，再验证 lease、幂等键与 outbox/审计边界 |
| 工具审批与权限政策 | 当前文件、角色、检查、发布均经批准范围或人工关口；工具是静态 allowlist | `LoopPolicy` 不获得权限扩张能力 | 若接入写外部系统，先设计逐调用 approval receipt、最小 capability 和回读/补偿契约 |
| 事件时间线与运行观测 | 已有检查、返工、调用、交付归档和 Store 状态，但尚无统一 operator timeline | 本次不另建事件系统 | 先定义事件 schema、保留期、脱敏与查询用例，避免把模型对话日志当审计事件 |
| 从成功轨迹学习 Skill | 有资源版本冻结和评测入口，但没有受控经验晋升管道 | 明确禁止自动自修改 | 需先建立“候选 playbook → 人审 → 离线评测 → 版本发布 → Run 冻结 → 回滚”闭环 |

结论：下一项最值得借鉴、但尚不应直接实现的能力是**版本化 repair playbook 的受控晋升**。它应消费已经验证的“失败签名—授权范围—实际修复—检查/评审结果”，只生成候选建议；不能从未验证的 Agent 对话中自动学习，也不能自行发布策略或增加工具权限。在完成真实模型 HRM 任务的无效返工率、人工升级正确率和成本基线评测前，不进入正式实现。

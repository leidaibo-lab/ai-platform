# 固化 Mastra Run 治理记录与冻结能力授权

- 状态：接受
- 日期：2026-11-12
- 负责人：Mastra 实践维护者
- 所属区域：独立应用实践
- 关联需求：将 Run、交接产物、证据、人工确认、批准范围和任务计划以可恢复、可验证边界接入 Mastra 原生主流程。
- 关联 OpenSpec：`openspec/specs/mastra-role-resources/spec.md`
- 替代记录：无；细化 [Mastra资源声明、Run冻结与最小角色契约](./2026-11-07-mastra-resource-contract.md) 与 [Mastra 可插拔自主 loop 与最小共享上下文](./2026-11-12-mastra-pluggable-autonomy-context.md)。

## 问题

当前实践已冻结角色资源、保留调用证据和审批暂停，但产物、审批范围及任务计划分别散落在 Workflow 状态、输入表单和检查条件中。角色输出不能以同一种结构携带 schema、hash 与证据引用；项目范围确认也尚未形成一个可被架构与执行守卫共同核验的冻结对象。

成功证据是：正式主流程在范围确认后生成唯一的能力授权；架构任务不能选择授权外角色、路径或检查；产品和开发角色输出以 Artifact 记录关联调用证据；上述对象不形成第二事实库或运行时。

## 约束与非目标

### 必须满足

- Mastra Workflow/LibSQLStore 继续是 Run、暂停、恢复和审批的唯一事实源。
- 授权必须绑定 Run、产品版本、人工范围确认和预算，模型文字不能扩权。
- 旧隔离评测/历史 DTO 保持可读取，不能被伪造的新授权静默迁移。
- 不读取或保存凭据、模型私有思维链和完整跨角色 session。

### 本次不解决

- 不增加认证身份、委托审批、到期撤销、跨实例授权分发或不可篡改外部审计日志。
- 不新建通用工作流平台、Artifact 文件库、策略插件市场或并行数据库。
- 不以固定模型或静态回归宣称真实模型质量、生产多实例恢复或自动发布已经完成。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 仅继续使用任意 Workflow 状态字段 | 最小改动 | 当前局部流程 | 改动最少 | 边界、hash 与下游消费不统一，范围授权容易散落 | 当前 `StateV2`、`delivery` 与 scope 表单 |
| 在 Mastra Store 状态上适配严格治理 DTO | 轻量可组合 | Artifact、Evidence、Approval、CapabilityGrant、TaskPlan | 保留原生暂停/恢复和资源冻结，变更面可控 | 后续认证和跨实例治理需另建决策 | 本实践的资源冻结、Invocation DTO、OpenSpec |
| 引入新的 Agent/审批/Artifact 平台 | 成熟一体化或自建 | 通用编排、授权、资产库 | 可能提供更多企业治理功能 | 重复 Mastra Run/Store 事实与恢复语义，迁移成本高 | 现有 `resource-config`、`runtime`、Workflow 主链 |

## 淘汰条件

- 产生与 Mastra Store 并列的 Run、审批或任务事实源。
- 授权对象可由模型输出、当前默认配置或恢复逻辑扩大。
- 将完整 Agent 对话、私有观察记忆或凭据写入 Artifact。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 授权摘要对无序范围稳定且拒绝篡改 | 纯契约回归 | `capability-grant.v1` | 通过 | `practices/mastra/tests/governance.test.ts` |
| 产物正文、契约与证据引用可统一追溯 | 纯契约回归 | `artifact.v1`、`task-plan.v1` | 通过 | 同上 |
| 类型边界可被全实践编译接受 | TypeScript 严格检查 | 当前 lockfile | 通过 | `npm --prefix practices/mastra run check` |

## 决策

- 结论：**适配**。
- 选择方案：在现有 Mastra Workflow 返回状态中引入严格、可哈希的治理 DTO；正式主流程由宿主创建并冻结`CapabilityGrant`。
- 决策依据：已有资源冻结、角色调用证据和最小 DTO 已提供可靠宿主边界，缺口是统一的跨阶段表达与范围授权对象，不是新的编排引擎。
- 平台拥有：治理 DTO schema、规范化 hash、CapabilityGrant 派生/校验、Artifact 证据引用和任务范围守卫。
- 外部方案负责：Mastra 继续负责 Agent、Workflow、Store、暂停恢复、原生工具循环和版本资源存储。
- 明确不实现：第二 Store、自由工具授权、模型自签审批、跨实例 capability broker。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| 任意状态字段约定 | 不能给授权/产物提供统一可验证边界 | 场景始终不需恢复或跨阶段追溯时 |
| 独立治理平台 | 将复制当前 Run、审批、冻结和恢复事实 | 需要认证、跨系统授权、不可篡改审计并且 Mastra Adapter 无法满足时 |

## 实施边界

- `resources/governance.ts` 是纯 DTO/Factory/Guard 层，不执行 I/O，不保存第二份状态。
- `product-development.ts` 只在项目范围人工确认后创建 CapabilityGrant；`development-v2.ts` 与 `validatePlanV2` 验证其子集关系。
- `product.ts`、`development/v2/agents.ts` 将角色输出封装为 Artifact；既有调用证据仍由宿主创建。
- `TaskPlan` 仅作为已校验计划和授权的摘要，不能驱动新的调度器。
- `HumanGate / ApprovalReceipt / AgentRun / EvidenceRecord` 全部是从原生暂停、resume、调用、检查和回执事实派生的只读投影；工作台不得以它们替换原生恢复输入。
- 工具回执只保留工具身份、调用关联和摘要；检查、部署、健康和回滚证据继续保存原有脱敏结构。任务级/调用级授权及过期/撤销不在本次实现。

## 验收与完成报告

- 验证证据：`npm --prefix practices/mastra run check`通过；纯 DTO 回归覆盖授权排序、跨Run拒绝、摘要篡改、Artifact—TaskPlan证据链、HumanGate/ApprovalReceipt/EvidenceRecord/AgentRun投影。
- 剩余边界：执行型 Workflow 回归需要 Node 24+及 OS 隔离后端；当前 shell 解析到 Node 20.16.0，因此未把该环境失败归因为本次实现失败。
- 文档与契约：已同步 Mastra资源 OpenSpec、运行资源契约、实践 README 与决策索引。
- 重评条件：接入真实身份、审批委托/撤销、外部副作用逐次授权、跨实例恢复或独立审计保留时，新增决策并评估成熟 authorization/audit 方案。

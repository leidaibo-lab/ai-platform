# 收敛 Mastra 研发团队 Agent 职责

- 状态：接受
- 日期：2026-11-14
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime
- 关联需求：将 `development-team` 收敛为负责人、动态实施者和独立审查者三类 Agent；自检与交付评估改为 Workflow 门禁
- 关联 OpenSpec：不涉及探索稳定契约；属于 Mastra 主线的内部 Workflow 组织调整（迁移前路径：`practices/mastra`）
- 替代记录：补充并细化 [Mastra Workflow 团队职责边界](./2026-11-14-mastra-workflow-team-boundaries.md) 的研发团队内部职责

## 问题

研发 Workflow 曾把 `context`、`architect`、`readiness`、`frontend`、`backend`、`infrastructure`、`self-check` 和 `reviewer` 同时表达为固定 Agent 角色。它混淆了业务阶段、任务路由和 Agent 实例，导致前后端等任务角色看似长期占用独立人员；更严重的是，自检依赖模型生成路由，真实工程检查无法单独成为放行事实。

成功证据是：主路径只实例化三类研发 Agent；前后端/后端/基础设施仅作为批准任务角色；自检没有模型调用但仍保存真实检查证据；实施前与实施后均有独立审查；人工范围、方案审批和业务阻塞回流保持不变。

## 约束与非目标

### 必须满足

- 保留 Mastra 原生 Workflow、Store、`dountil`、动态 `foreach`、受限委派、补丁合并和恢复事实。
- `development-lead-agent` 统一承担上下文核实、方案设计、任务拆分与动态组队。
- `development-implementer-agent` 仅按批准任务动态创建；任务角色继续约束路径和工具权限。
- `development-reviewer-agent` 同时承担实施前就绪审查和实施后代码审查。
- `development-self-check` 与 `assess-delivery` 只消费确定性 Workflow 与执行 Adapter 的事实。

### 本次不解决

- 不拆分研发团队为独立服务，不新增通用多 Agent 调度器。
- 不把真实模型质量、生产多实例恢复或完整业务验收写成已完成。
- 不移除历史评测的阶段审计标签；`self-check` 仍可作为验证记录的阶段值，不代表 Agent。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 现有 Workflow 内三类 Agent 映射与确定性门禁 | 轻量可组合适配 | 研发内部职责、动态任务与门禁 | 复用现有恢复、隔离执行和审批事实 | 同一 Agent 类型需通过阶段提示词区分交付 | `development/v2/agents.ts`、`workflows/development-v2.ts` |
| 保留八个固定角色 | 成熟现状延续 | 当前角色命名与评测 | 改动较小 | 把任务角色误当固定人员，且自检受模型影响 | 现有 `RoleV2` 与主 Workflow |
| 自建多 Agent 调度器 | 最小自研 | 新的成员、状态和恢复模型 | 可自由命名和编排 | 复制 Mastra Store、暂停、恢复与并行控制，形成第二事实源 | 团队边界 ADR 与现有 Workflow 能力 |

## 淘汰条件

- 方案若需要复制审批、恢复或检查证据，则淘汰。
- 方案若允许模型结论覆盖固定检查失败，则淘汰。
- 方案若将任务角色改为不受批准任务和精确路径约束的自由 Agent，则淘汰。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 正式主路径没有 `self-check` 模型调用 | 自主开发回归记录生成角色与验证历史 | fixture，`development-state.v2` | 通过 | `tests/development-autonomy.test.ts`、`src/mastra/workflows/development-v2.ts` |
| 动态实施仍按任务隔离和合并 | 既有多角色自主开发与补丁回归 | fixture，当前 Mastra 锁定版本 | 通过 | `tests/development-autonomy.test.ts`、`tests/unified-workflow.test.ts` |
| 自检和交付仍阻止无证据放行 | 检查失败、审查、交付门回归 | fixture，登记 Node 检查 | 通过 | `tests/development-autonomy.test.ts`、`tests/unified-workflow.test.ts` |
| Workflow 图可直接说明职责边界 | 检查团队边界、内部执行和各真实步骤的 `description` | 当前 Mastra Workflow | 通过 | `src/mastra/workflows/development-team.ts`、`src/mastra/workflows/development-v2.ts`、`src/development/v2/team.ts` |

## 决策

- 结论：适配
- 选择方案：在现有 Mastra Workflow 中将阶段 `RoleV2` 映射为三类 Agent；保留任务角色与阶段 ID；以确定性步骤执行自检和交付评估。
- 决策依据：该方案只改变职责表达和模型调用边界，保留已验证的任务授权、并行、补丁、暂停及恢复机制。
- 平台拥有：阶段到 Agent 类型映射、任务/路径授权、检查记录、交付门与返工路由。
- 外部方案负责：Mastra 的 Agent 调用、Workflow 调度、Store 持久化、暂停恢复和 `foreach` 并发。
- 明确不实现：固定前端/后端/基础设施 Agent、自检模型路由、第二套调度状态机或第二审批事实源。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| 保留八个固定 Agent | 职责边界与任务路由耦合，无法保证自检由真实检查而非模型结论决定 | 未来需要固定隔离身份、独立长期记忆或独立安全主体 |
| 合并审查与实施 Agent | 实施者无法独立审查自身变更，降低缺陷发现能力 | 无法承担独立审查的成本且以其他外部审查取代时 |
| 自建调度器 | 与 Mastra 原生 Store/恢复重复，增加状态分叉风险 | 出现跨实例调度、独立扩缩容或独立安全边界且 Mastra 不能满足 |

## 实施边界

- `RoleV2` 继续是阶段与任务审计字段；它不是对外 Agent 目录。
- `context`/`architect` 映射为负责人，`readiness`/`reviewer` 映射为审查者，三个实施任务角色映射为动态实施者；`self-check` 映射为 `null`。
- 动态实施实例继续使用 `memberId` 作为运行身份，避免并行任务共享记忆或越过任务边界。
- 自检失败在自主模式统一回到批准团队的实现阶段；非自主模式保留 `manual-attention`，不从模型文本推断责任。
- Store 继续拥有 `StateV2`、检查记录、审批、恢复和交付事实；执行 Adapter 继续拥有检查和候选源码 I/O。

## 实施计划

- 受影响路径：`src/development/v2/agents.ts`、`src/development/v2/team.ts`、`src/mastra/workflows/development-team.ts`、`src/mastra/workflows/development-v2.ts`、`src/evaluation/development-nodes.ts`、对应测试与研发文档。
- 核心数据结构：`DevelopmentAgentKind` 是三值映射；`RoleV2`、`StateV2.verificationHistory` 与 `phaseSchema` 保持现有版本和所有权。
- 遵循的模式：Workflow Composite 组合团队边界；Strategy 映射 Agent 类型；Adapter 继续隔离执行和检查。
- 不采用的模式：不引入 Agent 网络自由路由、全局可写 Agent 或模型驱动的检查通过判断。
- 依赖与配置：不新增依赖、环境变量或 Store 表。
- 实施顺序：先收敛工厂映射，再删除主路径的自检模型调用；同步评测与测试，最后更新文档和决策索引。
- 兼容与迁移：新 Run 使用新 Agent 身份；不为旧 Run 添加 Agent 别名或路径兼容。阶段审计值保留以读取已有记录。

## 验收计划

- [x] 功能：三类 Agent 映射、动态实施和确定性自检通过 `npm test`。
- [x] 结构：`development-self-check` 不经过 `invokeV2`/`generateV2`，交付门仍校验检查、审查和 hash。
- [x] 文档与契约：同步 README、研发流程、统一流程、决策索引；OpenSpec 不受影响。
- [ ] 剩余门禁：真实模型角色质量、完整 HRM 交付和生产多实例运行仍需单独验证。

## 风险与退出路径

- 已知风险：负责人和审查者在不同阶段复用同一 Agent 类型，阶段提示词或记忆隔离错误可能造成职责混淆；每次调用仍使用现有独立线程和阶段校验。
- 锁定点：当前依赖 Mastra Workflow/Store 和本地执行 Adapter 的语义。
- 退出路径：如出现独立安全边界，可保留三类 Agent 与跨边界 Schema，再拆出团队服务，不恢复八个固定角色。
- 维护责任：Mastra 实践维护者负责映射、Workflow 门禁与回归。

## 验收与完成报告

- 验证证据：`npm run check`、`npm test`（195/195）、`npm run review:build`、`npm run smoke` 与 `git diff --check` 通过。
- Workflow 呈现：`development-team` 及其内部真实节点均以 `plan-development`、`develop-and-check`、`review-development-quality` 标识阶段；节点描述同时标明负责人、动态实施者、独立审查者或确定性/人工门禁。仅补充描述，不改动稳定步骤 ID、暂停点或恢复路径。
- 剩余边界：不把 fixture 控制流、离线检查或独立评测当作真实业务/生产交付证据。
- 文档与契约：已计划同步 `README.md`、`development-workflow-design.md`、`unified-workflow.md`、`docs/README.md` 和决策索引；OpenSpec 不变。
- 重评条件：动态成员需要长期独立身份/记忆、检查执行迁移至远程 CI，或 Mastra 调度恢复语义变化。

## 证据与后续演进

- 执行日期与版本：2026-11-14，当前根目录锁定依赖与 fixture。
- 可追溯资产：Agent 工厂映射、确定性自检回归、研发节点评测和标准质量命令。
- 当前状态：实现验证通过；真实模型和生产门禁未完成。
- 后续记录：若研发团队拆分为独立服务或引入新的执行身份边界，新增替代决策。

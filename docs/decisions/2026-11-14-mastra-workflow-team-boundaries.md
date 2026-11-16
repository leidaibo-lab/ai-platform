# Mastra Workflow 按团队职责重组

- 状态：接受
- 日期：2026-11-14
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime
- 关联需求：将 Mastra 产研 Workflow 的节点职责收敛到产品、研发、测试、部署和交付团队
- 关联 OpenSpec：不涉及探索稳定契约；属于 Mastra 主线的 Workflow 组织调整（迁移前路径：`practices/mastra`）
- 替代记录：无

## 问题

原主流程把团队职责和执行步骤混在同一层：产品步骤、研发步骤、测试步骤、部署步骤和最终交付步骤同时作为顶层节点，导致流程图、暂停恢复和业务投影无法直接表达责任边界。需要让主流程回答“哪个团队负责”，让团队内部 Workflow 回答“该团队如何完成职责”。

成功证据是：主流程只暴露五个团队边界；团队内人工暂停、恢复、审计和失败定位仍可用；产品未批准时不进入研发；研发未交付时不进入测试和部署；最终交付只能由交付团队汇总同版本证据。

## 约束与非目标

### 必须满足

- `product-team` 负责 `guided-requirements`、`draft-product`、`review-product`。
- `development-team` 负责 `confirm-project-scope`、研发执行、阻塞澄清、开发自检、代码评审和研发交付检查。
- `test-team` 负责 `testing` 的完整测试与回归职责。
- `deployment-team` 负责 `deployment` 的完整发布、健康检查和回滚职责。
- `delivery-team` 负责 `confirm-final-delivery`。
- 继续使用 Mastra 原生嵌套 Workflow、Store 和 suspend/resume；不建立第二套审批事实源。

### 本次不解决

- 不为旧 Workflow 图、旧顶层节点路径或旧 Run 提供兼容映射。
- 不改变产品、研发、测试和部署内部业务契约；只调整其所属团队边界与主流程装配。
- 不把团队内部步骤合并成一个不可审计的黑盒；内部步骤仍保留用于暂停、恢复和证据追踪。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 原生嵌套团队 Workflow | 成熟一体化适配 | 主流程和团队责任边界 | 复用 Mastra 的输入校验、暂停恢复和快照 | 业务服务必须处理嵌套路径 | `src/mastra/workflows/product-development.ts` |
| 仅修改节点命名和页面分组 | 轻量局部改造 | 展示层职责 | 变更小 | 运行时所有权仍是平铺的，无法约束团队交接 | 现有主流程结构 |
| 自建团队调度器 | 最小自研 | 团队编排、恢复和审计 | 可完全定制 | 重复建设 Workflow 持久化、暂停和恢复，形成第二事实源 | 项目架构边界与 Mastra 原生 Workflow 现状 |

## 淘汰条件

- 方案不能让团队边界成为运行时 Workflow 边界时淘汰。
- 方案需要复制审批、恢复或执行状态时淘汰。
- 方案允许未批准产品进入研发，或未完成研发进入测试/部署时淘汰。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 五个团队可作为主链嵌套边界 | 主流程和统一交接测试 | fixture，Mastra 当前锁定版本 | 通过 | `tests/unified-workflow.test.ts` |
| 嵌套路径下的人工恢复仍能定位真实叶节点 | 澄清、产品失败、架构失败和跨 Store 回归 | fixture，主 Workflow 新路径 | 通过 | `tests/blocker-clarification.test.ts`、`guided-intake.test.ts`、`development-state-flow.test.ts` |
| 团队边界阻止错误交接 | 产品拒绝、研发停止、测试/发布失败场景 | fixture，主 Workflow | 通过 | `tests/unified-workflow.test.ts` |

## 决策

- 结论：适配
- 选择方案：使用 Mastra 原生嵌套 Workflow，将主链重组为 `product-team` → `development-team` → `test-team` → `deployment-team` → `delivery-team`。
- 决策依据：该方案最小化执行语义变化，同时让责任边界成为可审计、可暂停和可恢复的运行时结构。
- 平台拥有：团队边界、跨团队输入/输出 Schema、交接门禁、恢复路径投影和同版本证据校验。
- 外部方案负责：Mastra Workflow 的调度、持久化快照、暂停与恢复机制。
- 明确不实现：旧路径兼容层、第二套团队状态机和自建通用调度器。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| 仅改节点名称或 UI 分组 | 不能改变运行时责任边界，无法阻止跨团队错误交接 | Mastra 原生图无法表达嵌套责任，且已有成熟团队编排能力不足 |
| 自建团队调度器 | 会复制 Mastra 的执行、恢复和存储能力，增加事实源冲突 | 需要跨实例调度、独立扩缩容或团队拥有独立安全边界 |

## 实施边界

- `product-team` 内部装配需求澄清、产品成稿和产品审批；其拒绝/退回在团队边界终止，不进入研发。
- `development-team` 内部装配项目范围、研发执行、阻塞澄清和研发交付；其执行作用域由团队持有，测试、部署和交付只复用受控 Port。
- `test-team` 和 `deployment-team` 只接收研发交付后的生命周期状态；测试回归或部署失败不能绕过对应团队的人工门禁。
- `delivery-team` 只负责最终证据汇总和 `confirm-final-delivery`，不代替测试或部署批准。
- 服务层通过嵌套路径后缀定位叶节点，但恢复请求只能使用快照中实际存在的路径，不接受客户端指定任意步骤。
- 新 Run 使用新团队路径；旧路径不做迁移、别名或兼容投影。

## 实施计划

- 受影响路径：`src/mastra/workflows/product-team.ts`、`development-team.ts`、`product-development.ts`、`src/delivery/testing.ts`、`src/delivery/deployment.ts`、`src/intake/service.ts`、`src/intake/recovery.ts`。
- 核心数据结构：跨团队继续使用 `Delivery`、`StateV2` 和 `DeliveryLifecycle`；状态由原生 Store 所有，团队 Workflow 只返回 Schema 约束的新状态。
- 遵循的模式：Workflow Composite；团队 Workflow 组合已有内部步骤，Adapter 只负责仓库资产绑定和路径投影。
- 不采用的模式：不引入事件总线、第二审批库或按 UI 名称猜测步骤路径。
- 依赖与配置：不新增配置，不改变 Mastra、Zod 或存储版本。
- 实施顺序：先创建团队 Workflow，再重组主链；随后迁移恢复服务和断言；最后同步文档并执行检查、全量测试和 OpenSpec 校验。
- 兼容与迁移：本次明确不兼容历史 Workflow 路径；新 Run 从新图启动，历史数据不作为新图输入。

## 验收计划

- [x] 功能：产品、研发、测试、部署和最终交付按五个团队边界串联。
- [x] 结构：产品拒绝、研发阻塞、测试失败和部署失败均停留在正确团队边界。
- [x] 恢复：新嵌套路径下的产品写作、业务澄清和架构失败恢复通过回归。
- [x] 文档与契约：完成 README、统一流程说明、产品团队说明、决策索引和 OpenSpec 影响检查。
- [ ] 剩余门禁：真实模型和生产多实例运行仍不属于本次实践验收范围。

## 风险与退出路径

- 已知风险：Mastra 快照路径属于运行时结构，未来升级可能改变嵌套键；服务层必须继续从实际快照定位路径并保持回归。
- 锁定点：团队边界依赖 Mastra 原生嵌套 Workflow 和当前 Store 的路径投影语义。
- 退出路径：若未来需要独立团队服务，可保留五个团队的跨边界 Schema，按数据所有权拆分，而不是恢复平铺节点。
- 维护责任：Mastra 实践维护者负责团队边界、路径投影、恢复门禁和回归测试。

## 验收与完成报告

- 验证证据：团队边界与核心恢复测试通过；`npm run check` 通过；清理旧模型后的全量测试 194/194 通过。
- 剩余边界：真实模型质量、跨实例实时事件和生产部署不在本次范围。
- 文档与契约：已同步根 `README.md`、`docs/application/product-workflow.md`、`docs/application/unified-workflow.md`、`docs/README.md`；OpenSpec 不受影响。
- 重评条件：Mastra Workflow 路径语义变化、团队独立部署/安全边界出现，或跨实例恢复成为稳定需求时重新评估。

## 证据与后续演进

- 执行日期与版本：2026-11-14，仓库当前 Mastra实践依赖与 fixture 回归。
- 可追溯资产：`npm run check`、`npm test`、团队边界与恢复相关 Node tests。
- 当前状态：实现验证；真实模型和生产门禁未完成。
- 后续记录：若拆分团队为独立服务，新增替代决策并明确数据迁移与交接协议。

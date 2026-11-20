# 产品团队 Workflow

主入口 `productDevelopmentWorkflow` 的产品团队包含四个直属步骤。Mastra Studio 与工作台使用同一套中文名称和职责说明。

| 步骤 | 负责方 | 中文备注 |
| --- | --- | --- |
| `align-product-requirements` 对齐需求 | 产品经理 Agent、业务确认人 | 明确目标、范围和业务规则，有关键缺口时等待用户补充。 |
| `product-writing` 生成待审规格 | 产品经理 Agent | 生成需求文档和产品规格，校验并固化待审版本。 |
| `review-product-quality` 独立质量审查 | 产品审查 Agent | 独立核对待审版本的业务规则、异常流程和验收覆盖。 |
| `review-product` 人工审批与交接 | 产品负责人 | 由产品负责人审阅当前版本，批准后发布正式文档并交接研发。 |

逐项澄清在对齐需求步骤中多轮暂停和恢复。每次回答关联当前方案版本，已提交回答随原生 Run 保存。关键业务决定收敛后进入写作。AI 主动补全在同一步骤形成方向建议，推断标注为建议或待确认项。

`productWork.entries` 保存产品经理的阶段产物和执行事实，`productQualityReview` 保存独立审查结果。质量审查失败时从原生检查点复用已固化的产品稿。人工批准当前版本后由 `route-product-team-result` 放行研发。返工按影响重做方向或规格，并重新提交人工审阅。

## 新 Run 的正式交付

新建 live Run 在一次审阅中展示两份正文。需求文档记录业务目标、范围、规则及验收场景，产品规格将规则拆为可独立交付的任务。每项任务通过 `REQ-` ID 引用需求。结构校验拒绝缺失的文档、未知或重复引用以及未覆盖的需求。人工确认仍负责判断正文是否忠实表达实际业务。

初次批准和业务阻塞回流后的修订批准都将两份文档写入同一个正式 Run 分支的同一次提交。目录使用新建 Run 时输入的迭代标识。

- `product/<迭代标识>/requirements.md` 保存批准的需求正文。
- `product/<迭代标识>/product-spec.md` 保存批准的产品任务。

研发授权前按固定回执校验两份文件及其批准版本，研发任务和测试用例继续引用需求 ID。开发、测试规格仍在同一 Run 分支追加。产品团队页面发布后集中展示审批版本、批准人与正式文件入口。AI 方向初稿只在对齐方向阶段展示，原始输入仍可从「原始需求」查看。

## 产品需求与 OpenSpec

适合将已确认、跨迭代仍需遵守的产品行为写入业务仓库的 OpenSpec。需求文档保留业务背景、目标、范围和页面上下文。OpenSpec 用 `Requirement` 和 `Scenario` 固化权限、状态流转、校验和拒绝后的数据结果。产品规格用 `TASK-` 拆分本轮交付，通过 `REQ-` 关联同一业务规则。业务仓库采用 OpenSpec 后，以关联的规格章节为规则来源，需求文档引用该章节。

对已有 OpenSpec 的业务仓库，建议把本轮行为变化写入 `openspec/changes/<变更标识>/specs/<能力>/spec.md`，以 `ADDED`、`MODIFIED` 或 `REMOVED` 声明变化，关联批准稿的需求 ID。评审和验证后，按业务仓库流程归档到 `openspec/specs/<能力>/spec.md`。Mastra Store 保存审批事实，业务 Git 记录规格及变更。当前 Workflow 交付仍采用上述双文档路径，OpenSpec 的导出、校验和归档由业务仓库接入。

以 HRM 招聘为例，`REQ-SKIP-ACTUAL-START` 可以对应「已实际开始的面试不得跳轮」。场景写明面试已实际开始、尚未完成且没有评价，提交跳轮后拒绝，保留原轮次状态且不激活下一轮。研发和测试共同引用这一场景。

产品任务的写作和审查口径见[产品文档版式](../../nacos-resources/product/skills/product/requirements-handoff/references/document-layout.md#产品规格任务)。

## 恢复历史 Run

在 `product-team.product-direction` 和 `product-team.product-specification` 下运行的三阶段 Run 使用 `MASTRA_NATIVE_THREE_STAGE_PRODUCT_WORKFLOW=true` 恢复。此前在 `product-team.draft-product` 下运行的三阶段 Run 使用 `MASTRA_NESTED_PRODUCT_WORKFLOW=true` 恢复。更早的四段产品经理图含 `product-clarification` 和 `product-scope-priority`，使用 `MASTRA_LEGACY_PRODUCT_WORKFLOW=true` 恢复。每个恢复实例启动时选择对应的历史流程图。默认实例装配四步流程。

## 代码落点

- 产品团队装配：[product-team.ts](../../src/mastra/workflows/product-team.ts)
- 方向、规格阶段与产品经理/审查 Agent：[product-manager.ts](../../src/mastra/workflows/product-manager.ts)
- 可选需求澄清：[intake/workflow.ts](../../src/intake/workflow.ts)
- Agent 装配与中文职责说明：[agents/index.ts](../../src/mastra/agents/index.ts)、[agents/product-roles.ts](../../src/mastra/agents/product-roles.ts)
- 产品数据契约：[product-contract.ts](../../src/mastra/workflows/product-contract.ts)、[delivery.ts](../../src/mastra/workflows/delivery.ts)

## 验证边界

`npm run check` 验证类型和 Workflow 装配；`npm test` 验证澄清暂停/恢复、产品稿生成、独立质量检查、人工审批、返工和跨团队交接。fixture 模式只证明流程与数据边界，不证明真实模型的产品判断质量。

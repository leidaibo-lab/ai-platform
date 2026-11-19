# 产品团队 Workflow

本文描述当前主入口 `productDevelopmentWorkflow` 中的产品团队边界。产品团队是一个顶层团队 Workflow，内部再按产品经理、产品审查和人工审批划分职责；这些内部步骤不是主流程中的平行团队。

## 流程与 Agent 对应关系

```text
product-team｜产品团队
├─ product-direction｜对齐方向
│  ├─ guided-requirements｜多轮需求澄清与人工确认
│  └─ product-analysis｜AI 主动补全的方向建议
├─ product-specification｜完善规格
│  ├─ product-writing｜生成产品稿并固化待审版本
│  └─ review-product-quality｜独立质量审查
└─ review-product｜审阅交接
```

逐项澄清模式在关键业务决定已收敛后直接进入完善规格。AI 主动补全模式由产品经理先形成方向建议，再生成待审稿，推断需标注为建议或待确认项。

| 阶段 | 负责人 | 产出 |
| --- | --- | --- |
| 对齐方向 | 产品经理 Agent、业务确认人 | 方向建议或已收敛的人工业务决定 |
| 完善规格 | 产品经理 Agent、产品审查 Agent | 待审产品稿及独立质量证据 |
| 审阅交接 | 产品负责人 | 绑定当前产品稿哈希的人工决定与正式规格回执 |

`productWork.entries` 保存产品经理的阶段产物和执行事实，`productQualityReview` 保存独立审查结果。质量审查失败时从原生检查点复用已固化的产品稿。人工批准当前版本后由 `route-product-team-result` 放行研发。返工按影响重做方向或规格，并重新提交人工审阅。

## 恢复历史 Run

此前在 `product-team.draft-product` 下运行的三阶段 Run 使用 `MASTRA_NESTED_PRODUCT_WORKFLOW=true` 恢复。更早的四段产品经理图含 `product-clarification` 和 `product-scope-priority`，使用 `MASTRA_LEGACY_PRODUCT_WORKFLOW=true` 恢复。两项配置分别装配对应历史图，实例启动时只能选择一种。

## 代码落点

- 产品团队装配：[product-team.ts](../../src/mastra/workflows/product-team.ts)
- 方向、规格阶段与产品经理/审查 Agent：[product-manager.ts](../../src/mastra/workflows/product-manager.ts)
- 可选需求澄清：[intake/workflow.ts](../../src/intake/workflow.ts)
- Agent 装配与中文职责说明：[agents/index.ts](../../src/mastra/agents/index.ts)、[agents/product-roles.ts](../../src/mastra/agents/product-roles.ts)
- 产品数据契约：[product-contract.ts](../../src/mastra/workflows/product-contract.ts)、[delivery.ts](../../src/mastra/workflows/delivery.ts)

## 验证边界

`npm run check` 验证类型和 Workflow 装配；`npm test` 验证澄清暂停/恢复、产品稿生成、独立质量检查、人工审批、返工和跨团队交接。fixture 模式只证明流程与数据边界，不证明真实模型的产品判断质量。

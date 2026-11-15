# 产品团队 Workflow

本文描述当前主入口 `productDevelopmentWorkflow` 中的产品团队边界。产品团队是一个顶层团队 Workflow，内部再按产品经理、产品审查和人工审批划分职责；这些内部步骤不是主流程中的平行团队。

## 流程与 Agent 对应关系

```text
product-team｜产品团队
├─ draft-product｜产品成稿与质量检查
│  ├─ guided-requirements｜需求澄清（可选）
│  │  └─ product-manager-agent｜产品经理 Agent
│  ├─ product-analysis｜需求分析
│  │  └─ product-manager-agent｜产品经理 Agent
│  ├─ product-clarification｜需求澄清结果整理
│  │  └─ product-manager-agent｜产品经理 Agent
│  ├─ product-scope-priority｜范围与优先级
│  │  └─ product-manager-agent｜产品经理 Agent
│  ├─ product-writing｜产品稿写作
│  │  └─ product-manager-agent｜产品经理 Agent
│  ├─ publish-product｜发布待审产品稿
│  │  └─ product-manager-agent｜产品经理 Agent
│  └─ review-product-quality｜独立闭环检查
│     └─ product-reviewer-agent｜产品审查 Agent
└─ review-product｜产品负责人人工审批
   └─ 人工 reviewer｜批准、拒绝或终止当前产品版本
```

其中 `guided-requirements` 是 `draft-product` 内的可选需求澄清子流程。它和后续产品经理阶段共用 `product-manager-agent`，不会脱离产品团队成为独立团队节点。需求入口现在支持两种策略：`clarify` 保留逐项澄清；`autofill` 跳过人工问答，由产品经理 Agent 基于原始想法主动补全推荐闭环，直接生成待审产品稿。两种策略都必须经过 `review-product` 人工审批，`autofill` 不代表自动批准或自动进入研发。

`product-clarification` 不创建新的 Agent，它只负责让同一个产品经理 Agent 整理澄清事实、回答、假设和待决项；`product-analysis` 负责需求分析，`product-scope-priority` 负责范围与优先级，`product-writing` 负责完整产品稿。这样 Agent 数量保持精简，Workflow 阶段仍保留可审计的中间产物。

## 职责边界

| Workflow 流程 | Agent / 执行者 | 负责内容 | 不负责内容 |
| --- | --- | --- | --- |
| `guided-requirements` | `product-manager-agent` | 识别高影响缺口、生成澄清问题、吸收人工回答（`clarify`） | 不替用户确认业务选择，不进入研发实施 |
| `autofill` 入口策略 | `product-manager-agent` | 基于原始想法主动选择推荐闭环，补齐流程、边界、指标和验收，并标记假设/待确认项 | 不把推断写成已确认事实，不跳过产品人工审批 |
| `product-analysis` | `product-manager-agent` | 目标、用户、场景、约束和需求结构分析 | 不生成代码，不代替人工审批 |
| `product-clarification` | `product-manager-agent` | 整理已确认规则、事实、建议和未决项 | 不把推荐或假设写成已批准规则 |
| `product-scope-priority` | `product-manager-agent` | 首期范围、非目标、优先级和可检查验收边界 | 不执行测试，不代替独立质量审查 |
| `product-writing` | `product-manager-agent` | 生成完整 Markdown 产品稿 | 不声称产品已批准 |
| `review-product-quality` | `product-reviewer-agent` | 独立检查目标、范围、规则、异常路径、验收、非目标和风险 | 不修改原稿，不代替人工批准 |
| `review-product` | 产品负责人 / 人工 | 对当前产品稿 hash 做批准、拒绝或终止决定 | 不替代 Agent 生成产品稿 |

## 数据与质量门

- `productWork.entries` 按产品经理阶段顺序保存中间产物，并记录真实 Agent、工具、文件和生成时间事实。
- `productQualityReview` 只保存 `product-reviewer-agent` 的独立质量证据，不等同于人工批准。
- `publish-product` 生成待审产品版本；只有 `review-product` 的 `approve` 才能通过 `route-product-team-result` 进入 `development-team`。
- `reject` 或 `rework-requested` 在 `product-team` 边界终止当前版本，不进入研发；返工必须产生新的产品版本和新的人工审批。
- 需求澄清、产品稿生成或产品质量检查失败时，只允许从原生快照中的真实失败步骤恢复，不接受客户端替换步骤或正文。

## 代码落点

- 产品团队装配：[product-team.ts](./src/mastra/workflows/product-team.ts)
- `draft-product` 与产品经理/审查 Agent：[product-manager.ts](./src/mastra/workflows/product-manager.ts)
- 可选需求澄清：[intake/workflow.ts](./src/intake/workflow.ts)
- Agent 装配与中文职责说明：[agents/index.ts](./src/mastra/agents/index.ts)、[agents/product-roles.ts](./src/mastra/agents/product-roles.ts)
- 产品数据契约：[product-contract.ts](./src/mastra/workflows/product-contract.ts)、[delivery.ts](./src/mastra/workflows/delivery.ts)

## 验证边界

`npm run check` 验证类型和 Workflow 装配；`npm test` 验证澄清暂停/恢复、产品稿生成、独立质量检查、人工审批、返工和跨团队交接。fixture 模式只证明流程与数据边界，不证明真实模型的产品判断质量。

# 用三层 Harness 表达产研主线职责

- 状态为接受，依据已确认的三层设计及当前主线实现。
- 日期为 2026-11-19，维护者为主线平台、各专业团队与项目维护者。
- 替代[两类 Harness 职责决策](./2026-11-18-platform-team-harness.md)的架构口径。沿用 [Mastra 主线](./2026-11-16-mastra-v2-mainline.md)及[团队职责边界](./2026-11-14-mastra-workflow-team-boundaries.md)。
- 行为依据为[主线 OpenSpec](../../openspec/specs/project-mainline/spec.md)的产品返工、项目绑定和需求验收证据契约。

## 问题与约束

旧图把项目配置、专业工程规则和角色方法画在同一个区域。现在产品、开发、测试 SDD 及保护检查已能经固定 Git 版本接入主流程，需要明确它们由项目维护，与团队内部方法分别演进。审批、暂停和恢复继续由 Mastra Store 持有。实现角色只在获批路径内实施，保护检查由项目登记。

## 决策

结论为适配。两类口径能表达平台执行与团队自治，三层口径进一步表达项目规范的维护者、Git 版本和适配入口，因此采用三层。跨团队顺序、交接和返工路由继续由主 Workflow 负责。

| 职责 | 维护内容 | 可核对的实现 |
| --- | --- | --- |
| 平台 Harness | 中止、原生暂停恢复、授权、隔离与证据完整性 | [运行中止](../../src/mastra/platform/interruptible-attempts.ts)、[快照等待](../../src/mastra/platform/workflow-recovery.ts) |
| 团队 Harness | 角色协作、专业检查、团队内返工和升级。Prompt、Skill 和工具装配限定角色方法 | [产品返工](../../src/mastra/workflows/product-rework.ts)、[研发团队](../../src/mastra/workflows/development-team.ts) |
| 业务工程 Harness | Git 中的 SDD、验收规范、候选基线及保护检查。由项目 Adapter 装配到对应阶段 | [登记项目](../../src/business-engineering/project.ts)、[验收需求](../../src/business-engineering/acceptance-requirements.ts) |
| 业务编排 | 跨团队调用、版本交接、人工关口、最终交付判定 | [主 Workflow](../../src/mastra/workflows/product-development.ts) |

## 实施和验证边界

- 产品纠偏与审阅退回使用同一团队返工判断，重新生成的稿件回到人工审阅。SSE 展示进展，原生快照决定能否恢复。
- 显式登记项目按实例绑定仓库与 Git commit，当前采用 `node-test.v1`。默认 HRM 使用兼容入口。同一 Run 恢复绑定原项目版本，后继 Run 可引用同仓库已验证的旧规格并采用新工程版本。
- 主图、架构说明、协作规则和流程入口采用本决策的术语。[资源清单](../application/visual-framework.md#仓库资源同步清单)记录需联动维护的仓库文件。
- 当前证据包括合成库存全流程及 HRM 兼容回归，见[边界回归](../../tests/harness-boundaries.test.ts)。更多技术栈、真实业务验收和跨实例恢复按[演进任务](../application/harness-architecture.md#演进任务与验收)评估。

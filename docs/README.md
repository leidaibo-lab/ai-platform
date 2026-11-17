# 项目文档

根目录是 AI 应用基础平台 v2.0 的 Mastra 主线。当前应用入口、工作台、配置、评测和运行说明均以仓库根目录为准；原自研 Runtime 的历史材料已收拢到 [`practices/custom-exploration/docs/`](../practices/custom-exploration/docs/)。

## 应用与操作

- [完整产研流程](./application/unified-workflow.md)：产品、研发、测试、部署和交付团队的主流程与人工关口。
- [产研角色资源清单与绑定](./application/agent-resource-inventory.md)：产品 Prompt、Skill 的当前来源、目标绑定与迁移缺口，以及宿主执行边界。
- [产品 Nacos 资源候选](../nacos-resources/product/README.md)：跨电脑共享的角色 Prompt、资源声明与 Skill 包准备方法。
- [需求工作台](./application/guided-intake.md)：逐项澄清与 AI 主动补全、产品确认和恢复边界。
- [工作流执行时间线](./decisions/2026-11-14-mastra-workflow-execution-timeline.md)：RunFlowMini、RunActivityFeed 与 SSE 的只读投影边界。
- [运行产物与数据流](./application/artifact-dataflow.md)：项目、迭代、Run、阶段产物和只读 Workspace。
- [研发阶段设计](./application/development-workflow-design.md)：团队化研发、受限实现、自检与独立评审。
- [浏览器 QA](./application/browser-qa.md)：浏览器用例、截图证据与质量门。
- [工作区资料](./application/workspaces.md)：只读业务资料和运行产物导出。

## 约束、决策与评测

- [架构与方案决策](./decisions/README.md)：接受、替代与历史决策索引。
- [v2.0 迁移方案](./v2-migration-plan.md)：完整远端基线、目录迁移和验证状态。
- [根主线协作规则](../AGENTS.md)：运行边界、配置和安全约束。
- [OpenSpec](../openspec/project.md)：稳定行为契约与主线范围。
- [产品 Skill 套件](../.agents/skills/README.md)：产品 Agent 的本地方法入口与来源锁。
- [开发评测](../evaluations/README.md)：fixture、真实模型与人工验收的证据边界。

历史 ADR 记录会保留当时的路径与结论；凡指向当前应用的链接已以本索引和根目录入口为准。

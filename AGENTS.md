# AI 应用基础平台协作规则

项目 v2.0 主线以根目录 Mastra 应用为准。原自研实现位于
`practices/custom-exploration/`，遵循该实践的局部规则。两者独立持有运行依赖、配置和数据。

## 通用要求

- 默认中文协作；提交标题遵循 `type(scope): 中文说明`。
- 不读取、打印或提交真实密钥；环境变量样例只放 `.env.example`。
- 修改行为契约先更新 OpenSpec；文档、配置和接口引用保持同步。
- 所有函数有紧邻职责注释；公共或复杂函数使用 JSDoc；变更遵守 KISS、DRY、YAGNI 和单一职责。
- Mastra 是主线运行框架。不要将探索 Runtime、GatewayClient 或 SQLite 导入主线。
- Mastra Store 持有 Workflow 执行、审批和恢复事实；文件或业务仓库投影不得成为第二事实源。
- 未经授权不得推送远端、部署或删除数据。

## 主线入口

- 应用：`src/mastra/`、`src/`、`config/`
- 工作台：`web/`
- 维护、回归与评测：`scripts/`、`tests/`、`evaluations/`
- 产品 Skill：`.agents/skills/product-pm/`
- Mastra 操作文档：`docs/application/`
- 稳定契约：`openspec/specs/mastra-role-resources/`、`openspec/specs/project-mainline/`
- 当前迁移变更：`openspec/changes/promote-mastra-v2/`
- 当前接受决策索引：`docs/decisions/README.md`

主线配置应显式区分 fixture/live 及数据目录；测试使用隔离数据。真实模型调用、费用、远端仓库写入和签名私钥须明确处理。

## 探索实践

`practices/custom-exploration/AGENTS.md` 约束自研 Runtime、Demo、LiteLLM 和 pi 适配实验。
不得把其天气、图片、会话或可靠性能力自动计入 Mastra 主线。

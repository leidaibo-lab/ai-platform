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

## Codex 工具等待

- 长时间运行的测试、构建和检查应保留可检查的日志与退出结果。等待已有会话时，优先使用一次有界长等待（例如 `write_stdin` 的 `yield_time_ms: 60000`）。达到任务预设的总等待期限时，检查并报告实际状态。
- 同一工具、同一目标连续得到相同状态且无新进展时，最多连续等待两次。随后检查日志增量、进程状态或退出结果。确认任务仍在运行且尚未到期限时，可按剩余时间继续有界等待。仅调整调用参数不算新进展。
- 新日志、新分页内容、状态变化或明确的交互提示允许继续使用同一工具。查证后仍无法判断任务状态时，报告最后可确认的结果与待验证项，不能将等待超时视作命令失败或验证通过。

## Harness 架构约束

- 遵循[三层 Harness 与跨团队编排](docs/application/harness-architecture.md)及其[接受决策](docs/decisions/2026-11-19-three-layer-harness.md)。平台 Harness 提供通用执行治理，团队 Harness 负责专业执行与验收闭环，业务工程 Harness 维护 Git 中版本化的 SDD 与保护检查。项目适配装配仓库、环境和检查，业务编排负责跨团队协作。
- 新增能力先明确职责归属；团队复用 Mastra 原生运行事实和受控执行 Port，不自建审批/恢复引擎。通用机制不得固化 HRM 路径、命令或团队专业策略。
- 团队方法和检查应版本化；实现 Agent 不得修改受保护检查、降低验收标准或自行扩权。行为变化先更新 OpenSpec。
- 当前归属不等于代码已解耦；后续抽取按架构文档 H1–H4 任务和实际复用需求推进，以使用方和已验证的职责边界决定模块拆分。

## 开工阅读与验证

- 开工按改动范围核实稳定规格和接受决策，不以 README 或历史聊天替代契约。涉及跨团队编排、Team Loop、项目适配或执行身份时，读取[Team Loop 与项目 Adapter 架构](docs/application/team-loop-architecture.md)及其[接受决策](docs/decisions/2026-11-21-unified-team-loop-and-project-adapters.md)；涉及审批或恢复时，核对对应 Workflow 与 OpenSpec 的版本和兼容要求。
- 注册表模式下，项目身份从已验证的 Run 绑定解析，并贯穿上下文、候选、资产、归档、同步、后继 Run 和 MR。不得以共享可变配置、默认仓库回退或客户端路径替代绑定；执行与恢复不得静默接受项目或 Adapter 身份漂移。
- 模型提案、独立评审、真实检查、人工批准和远端回执分别记录，不得相互替代。完成说明须列明实际验证及未验证范围；fixture 通过不代表真实模型质量、真实远端交付或生产验收通过。

## 主线入口

- 应用：`src/mastra/`、`src/`、`config/`
- 工作台：`web/`
- 维护、回归与评测：`scripts/`、`tests/`、`evaluations/`
- 研发架构送审 Skill：`.agents/skills/development/architecture-document/`。研发负责人生成正文和图，就绪审查核对其与任务包的一致性。
- 产品 Skill 位于 `nacos-resources/product/skills/`。正式需求写作与复核见 `product-pm/product-requirements-alignment`，平台版式与双文档追踪见 `product/requirements-handoff`。本地与 Nacos 候选绑定统一由 `nacos-resources/product/manifest.json` 定义。
- Mastra 操作文档：`docs/application/`
- 稳定契约：`openspec/specs/mastra-role-resources/`、`openspec/specs/project-mainline/`
- 当前迁移变更：`openspec/changes/promote-mastra-v2/`
- 当前接受决策索引：`docs/decisions/README.md`

主线配置应显式区分 fixture/live 及数据目录；测试使用隔离数据。真实模型调用、费用、远端仓库写入和签名私钥须明确处理。

## 探索实践

`practices/custom-exploration/AGENTS.md` 约束自研 Runtime、Demo、LiteLLM 和 pi 适配实验。
不得把其天气、图片、会话或可靠性能力自动计入 Mastra 主线。

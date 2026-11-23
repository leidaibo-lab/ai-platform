# 主线 Agent 工具索引

本索引用于发现和审查工具，不是全局运行时注册表。工具由所属模块在创建 Agent 或调用时按角色和任务显式装配；方法和 Skill 不授予工具权限。具体授权、批准路径、执行预算及回执以宿主和 Workflow 为准。

| 工具或工具集 | 归属与定义 | 装配及边界 |
| --- | --- | --- |
| `practiceInfo`（`practice-info`） | [平台工具](./practice-info.ts) | 最小 Agent 和评测的固定只读信息，无网络或写入。 |
| Mastra Workspace 文件读取、列表、属性和搜索 | [项目工作区](../project-workspaces.ts)、[阶段快照](../stage-workspace.ts)、[研发执行环境](../../development-execution.ts) | 按工作区配置启用四种只读能力；阶段资料和研发候选各有独立边界，不向模型开放原生写入或任意命令。 |
| Mastra `skill`、`skill_read` | Mastra 原生能力；方法由 [团队方法模块](../team-methods.ts) 装配 | 仅提供当前角色所需方法；方法内容不扩大权限。 |
| `handoff.locate`、`handoff.read`、`handoff.search` | [交接上下文](../../delivery/task-context.ts) | 调用期资料引用、跨已登记资料字面检索、有界定位和分段读取；不能读取任意路径。 |
| `writeFile`、`runChecks`、`readCheckEvidence`、`delegateTask` | [研发 V2 工具](../../development/v2/tools.ts) | 按角色、自治配置和成员运行时装配；写入限批准路径，检查由宿主固定；检查回执可按序号和 ID 分页查询；委派由宿主校验。另有 [旧研发工具](../../development/agents.ts)。 |
| `candidateChanges`、`candidateDiff`、`codeStructure`、`codeReferences` | [研发候选查询](../../development/v2/query-tools.ts) | 比较 Run 输入基线与当前隔离候选，查询单文件 JS/TS 语法及候选内语义引用；语义查询不加载外部依赖或编译配置。 |
| `external.search`、`external.readPage` | [外部资料工具](./external-research.ts) | 配置后仅在 live 产品生成和审查调用期间启用；查询发往 Tavily，网页只能选择本次搜索结果。 |
| `runBrowserCase` | [浏览器 QA 工具](../../browser-qa/tools.ts) | 仅可选择本次批准的用例 ID；同一用例只执行一次，回执属于本次调用。 |

增加或调整工具时，应同时更新此索引，并核对角色装配、工具输入、权限边界和实际验证。涉及行为契约变化时先更新 OpenSpec。

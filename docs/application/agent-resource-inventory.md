# 产研角色资源清单与绑定

盘点基于当前代码，目标是让可编辑的角色、任务 Prompt 和 Skill 由 Nacos 版本化管理。下列 `product.*` 是**建议资源 ID**，不是已发布资源或当前生效配置。实际发布版本、审批和角色绑定尚未建立；此文不作为运行时注册表。已有 [Nacos 方案](../decisions/2026-11-17-nacos-mastra-resources.md)的生产验收边界继续适用。

## 产品角色绑定表

| 角色及阶段 | 当前绑定 | 目标资源及能力 | 当前状态 |
| --- | --- | --- | --- |
| 产品经理：澄清、分析、范围、写作 | `product-manager-agent`；配置中的主 Prompt、主 Skill 和追加 Skill | `product.role.manager`；按角色绑定产品 Skill 集；分别绑定 `product.task.intake`、`product.task.analysis`、`product.task.clarification`、`product.task.scope-priority`、`product.task.writing` 及补全/澄清模式指令 | 角色 Prompt/指定 Skill 可按 Run 冻结；阶段和模式指令仍在代码 |
| 独立产品审查 | `product-reviewer-agent`；可选独立 Prompt，否则复用主 Prompt；可配置冻结 Skill 子集 | `product.role.reviewer`、`product.task.review` 和独立审查 Skill 集 | Prompt 和 Skill 子集可独立配置；任务 Prompt 仍在代码 |
| 研发阻塞回流产品经理 | 同一产品经理角色；分析阻塞及按人工回答修订 | 原 Run 冻结的 `product.role.manager` 和 Skill；`product.task.blocker-questions`、`product.task.revision` | 调用产品 Agent 已接回原 Run 快照；两项任务指令仍在代码 |
| 产品文档阅读助手 | `reading-agent`，独立只读问答 | `product.role.reader` | Prompt 在代码；不属于当前产品成稿的 Nacos 接入范围 |

未配置审查 Skill 子集时，两角色共用全部已配置 Nacos Skill；配置子集后按 Run 冻结。旧 Run 和显式关闭 Nacos 的运行继续读取本地资源；新 Run 不自动加载原本地套件。

## 产品 Prompt 资源清单

| 建议资源 ID | 内容与变量 | 当前来源 | 迁移状态 |
| --- | --- | --- | --- |
| `product.role.manager`、`product.role.reviewer` | 角色职责、专业方法、优先 Skill | `src/mastra/agents/product-roles.ts`；Nacos 快照 `prompt`、可选 `reviewerPrompt` | 角色正文支持 Nacos；名称、任务说明和部分角色边界仍由 `src/mastra/agents/index.ts` 拼接 |
| `product.role.skill-guidance` | 方法选择、按需读取、交接方法及实际使用报告 | `src/mastra/agents/index.ts` 的 `instructions.product` | 本地兼容路径使用；新 Nacos 路径仅有简短调用提示，尚未恢复原交接 Skill 要求 |
| `product.role.task-and-boundaries` | 阶段职责、事实与建议区分、只读工具使用说明 | 同文件 `productTask`、`productBoundaries`、`workspaceInstructions` | 仍拼在代码中；提示文字可迁移，权限必须由宿主执行 |
| `product.task.intake`、`product.shared.question-decision` | 原始需求、历史回答、成熟度、提问及 JSON 指引 | `src/intake/workflow.ts`、`src/intake/contracts.ts` 的 `questionDecisionInstructions` | 代码，待迁移；结构与确认规则仍由 schema/宿主校验 |
| `product.task.analysis`、`product.task.clarification`、`product.task.scope-priority`、`product.task.writing` | brief、已确认回答、历史阶段产出、返工反馈 | `src/mastra/workflows/product-manager.ts` 的 `managerPhaseInstructions` | 代码，四个阶段分别迁移 |
| `product.mode.autofill`、`product.mode.clarify` | 主动补全和逐项澄清模式指引 | 同文件 `modeInstruction` 和阶段公共 `instruction` | 代码，待迁移；不能把 AI 建议变成人工批准 |
| `product.task.review` | brief、产品稿、独立审查指引 | 同文件 `qualityReview` | 代码，待迁移 |
| `product.task.blocker-questions`、`product.task.revision` | 已批准原稿、业务阻塞、历史、人工回答和修订指导 | `src/intake/blocker-workflow.ts`；共用 `questionDecisionInstructions` | 代码，待迁移；产品角色调用复用原 Run 快照 |
| `product.role.reader` | 只读解释产品文档及审阅状态 | `src/mastra/agents/index.ts` 的 `readingAgent` | 代码，待纳入统一治理 |
| `shared.context.material-policy` | 原文定位、分片读取、来源与材料使用说明 | `src/delivery/task-context.ts` | 多角色共用，待迁移；真实读取权限仍由工具控制 |
| `shared.memory.observer`、`shared.memory.reflector` | 保留来源、已确认约束和未决项的观察/反思指令 | `src/mastra/context-memory.ts` | 多角色共用，待迁移；需验证 Mastra Memory 配置与恢复语义 |

这些资源将变量数据和模板分开；远程模板变更不得改变输出 schema、审批事实或工具权限。以当前冻结身份覆盖角色 Prompt、阶段 Prompt、Skill 名称、精确版本、内容和摘要，是目标而非已实现状态。

## 产品 Skill 资源清单

| 范围 | 资源与来源 | 当前绑定与目标 |
| --- | --- | --- |
| 111 项产品方法 | 69 原子 Skill、42 流程 Skill，逐项原名和本地 ID 见 [完整能力目录](../../nacos-resources/product/skills/product-pm/catalog/references/catalog.md)；正文和来源锁位于 `nacos-resources/product/skills/` | 本地兼容路径全量可见；新 Run 只有显式配置且已发布的 Nacos Skill。目标逐项发布、保留来源和许可证，并由角色绑定版本 |
| 1 项导航 | `product-pm-catalog`，含目录和 `references/shipping/` 辅助资料 | 当前本地套件加载；目标单独发布并完整保留引用，脚本仅可作文本参考，不授予执行权限 |
| 1 项交接方法 | `product-requirements-handoff`：`nacos-resources/product/skills/product/requirements-handoff/SKILL.md` | 本地兼容路径加载；目标在经理交付绑定，并由流程验证真实方法使用，不能仅靠 Prompt 声称已调用 |

本地共 113 个入口，目录和许可证不等于远端已发布。每个 Skill 包须逐项检查名称、版本、来源、许可证、references、摘要及打包安全；当前 ZIP 只接受 `SKILL.md` 和 `references/`，须先确认完整引用和文件兼容。当前最多 128 个 Skill、单包/响应 1 MiB、快照总计 8 MiB；这些是适配器限制，不代表全部资产已经验证能装入一个 Run。

2026-11-17 本地只读盘点：迁移前 `product-pm` 112 个目录合计 1,054,304 字节，最大单目录 250,586 字节、最多 15 个文件；各目录文件均位于入口或 `references/`。原文现已迁至 `nacos-resources/product/skills/` 并通过来源锁和全套方法装配测试；真实 Nacos 全量发布仍待验证。

本地角色的优先方法：产品经理为 `product-pm-flow-triage-requests`、`product-pm-analyze-feature-requests`、`product-pm-prioritization-frameworks`、`product-pm-create-prd`；审查为 `product-pm-test-scenarios`、`product-pm-strategy-red-team`、`product-pm-pre-mortem`。它们是选法提示，本地两角色实际都能看到全套；Nacos 审查角色可以绑定已冻结集合的名称子集。

## 其他角色绑定与后续范围

| 角色/阶段 | 当前 Prompt 和 Skill 来源 | 迁移说明 |
| --- | --- | --- |
| 研发负责人：上下文、架构 | `src/development/v2/agents.ts`；分别绑定 `development-bmad-context`、`development-bmad-task-handoff` | 本地锁定；需保留来源锁、`methodBundleHash`、审批与恢复身份 |
| 研发审查：就绪、代码审查 | 同文件；分别绑定 `development-bmad-readiness`、`development-bmad-code-review` | 本地锁定；同上 |
| 前端、后端、基础设施实施 | `src/development/agents.ts`、`src/development/v2/agents.ts`；当前不单独绑定 Skill | Prompt 可迁移；文件、命令、委派权限由宿主限定 |
| 独立测试、部署 | `src/mastra/agents/index.ts`，任务指令在 `src/delivery/testing.ts`、`src/delivery/deployment.ts` | Prompt 待迁移；当前没有单独 Skill；测试执行和发布回执有宿主门禁 |
| 浏览器 QA | `src/browser-qa/agent.ts`；`testing-gstack-browser-qa` 和 `src/browser-qa/method.ts` 来源锁 | Prompt/Skill 待迁移；保留候选版本、来源锁及浏览器权限 |
| 最终交付 | 确定性 Workflow：`src/mastra/workflows/product-development.ts` | 不凭空设 Agent 或 Skill；依据测试、部署与健康回执放行 |

## 已确认的宿主执行边界

以下是必须由可信宿主**执行与校验**的机制，不等于要求把其描述性 Prompt 留在代码；这些机制的参数可以受治理地配置，但不能由未经授权的远端内容扩大权限。

1. 角色与工具身份、工具注册及权限上限：工具 allowlist、只读 Workspace、文件路径和命令权限由宿主控制；展示名称与专业职责可以迁移。
2. 结构化输出 schema、必答/引用/版本校验和失败处理：保证结果能被流程安全消费；给模型的 JSON 说明可以迁移。
3. 人工审批、暂停恢复与事实所有权：Workflow/Store 保存真实人工决定和 Run 状态；Prompt 只能提出建议。
4. 资源身份、精确版本、hash、解包限制及每 Run 快照：恢复必须继续使用原版本或明确失败；凭据由宿主安全注入，不写入资源或快照。
5. 模型调用安全上限和工具执行预算：由宿主实施上界；业务预算和角色策略可以在授权范围内配置。

用户已确认保留以上五类宿主执行边界。当前代码中的 `productTask`、`productBoundaries`、角色名称或阶段文字并未证明必须硬编码，均应列为可迁移文本，不能用上述机制作为拒绝迁移的理由。

## Skill 包准备与验证

执行 `npx tsx scripts/prepare-nacos-product-skills.ts <尚不存在的输出目录> 1.1.0` 可准备 113 个独立 ZIP 和 `manifest.json`。工具检查上游来源锁和许可证、限制文件布局、拒绝符号链接，并记录原文件与 ZIP 的 SHA-256；输出状态明确为待审核、未发布。版本为调用者指定的迁移候选版本，不能视为已有注册中心版本或审批结论。目录必须不存在，以避免覆盖已有审查材料。

`tests/nacos-product-suite.test.ts` 用本地 HTTP 模拟 Nacos，将全部 113 个真实 Skill 包经现有 Adapter 冻结并按原版本复核，比较参考资料清单，再装配到锁定版本的 Mastra 两个产品 Agent。该测试不证明真实 Nacos 上已发布、人工审批完成或产品角色的真实模型质量；另有测试覆盖审查角色只加载绑定子集。

跨电脑的候选入口位于 `nacos-resources/product/`；本机注册脚本及使用方法见该目录 README。隔离 Nacos 3.3 已发布并读回全部 113 项 Skill 和两个角色 Prompt；注册幂等及同版本冲突也由模拟服务验证。其他机器注册、生产治理和阶段 Prompt 迁移仍待完成。真实 Run 证据及限制见 [live 流程验证](./nacos-live-run-findings.md)。

## 按顺序完成迁移与证据

1. 产出逐项资源包和清单：113 个 Skill 的内容、references、来源许可、版本、hash、审批及 ZIP 兼容；整理上述 Prompt 与输入变量。发布前审查内容，不在资源里存凭据。
2. 设计并实现 Nacos 角色绑定和阶段 Prompt 清单：角色各自指定精确资源版本，校验引用、重复和上限，初始化 Run 一次冻结，产品审批 hash 绑定全部实际资源；旧快照保持兼容。Nacos 负责分发版本化资产，Mastra Workflow 仍负责调度、状态和审批。
3. 完成产品所有阶段和阻塞回流的迁移；验证 Run 暂停、进程重启、发布新版本、原版本下线/权限撤销、篡改、旧 Run 兼容和工具权限隔离。角色资源及模板的变更应有可复核审批记录。
4. 在隔离 Nacos 3.3 上发布并读取真实产品资源包，核对每个引用和许可；再由目标环境负责人按最小权限发布到实际命名空间。使用真实模型和业务样例对提示词与方法质量做单独验收；Mock 通过不代表业务效果或生产认证完成。

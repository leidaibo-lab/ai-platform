# 以 Run 分支候选、质量回执和人工 PR 合并交付 Mastra 代码

- 状态：接受
- 日期：2026-11-13
- 负责人：Mastra 实践维护者
- 所属区域：平台控制面 / 治理与可观测
- 关联需求：将产品、架构、候选代码、测试和发布证据按 Run 增量交接至 Git；发布成功后创建 PR，等待人工审批再合并 `main`。
- 关联 OpenSpec：`openspec/specs/mastra-role-resources/spec.md`
- 替代记录：[2026-11-09-mastra-code-publication.md](./2026-11-09-mastra-code-publication.md)

## 问题

原流程直到独立测试通过才把业务源码写入 Run 交接分支。测试、发布只能依赖本地候选目录和 Store，跨机器审阅不便，且无法将测试用例/质量证据精确绑定到一个已推送的候选 commit。成功证据是：产品与架构资料按阶段可追溯；开发交付形成待测试候选 commit；测试和发布只消费同一 commit；发布健康通过后，人工 PR 回执精确说明 `codex/workflow/<RunId> -> main` 已合并。

## 约束与非目标

### 必须满足

- Mastra LibSQL Store 仍是 Run、审批、暂停与恢复的唯一事实源；Git 是版本化交接投影。
- Workflow、模型和浏览器不得持有 GitHub 凭据，且不得直接创建 PR、批准 PR 或写入 `main`。
- 候选代码只允许来自已批准路径、研发交付和通过自检的隔离候选；不得修改用户 checkout、index 或当前分支。
- 测试、发布和 PR 回执必须绑定同一源码散列与 Run 分支 commit；版本漂移拒绝。

### 本次不解决

- 不接入 GitHub/GitLab API、Webhook、CI/CD 或自动 PR 创建/合并。
- 不支持删除文件、自动 rebase、冲突解决、多仓按角色拆分或跨实例恢复。
- 不把人工外部回执误写为机器独立验证。

## 候选方案

| 候选 | 路线 | 关键优势 | 关键缺口或风险 | 结论 |
| --- | --- | --- | --- | --- |
| GitHub API + Actions | 成熟一体化 | 可创建 PR、获取审批和合并状态 | 需要新增凭据、权限、Webhook 和 CI 运行边界 | 暂不采用 |
| Git CLI + Mastra Step + 人工 PR 回执 | 轻量可组合 | 复用现有独立 index、提交、push、暂停/恢复与回执模型 | PR 操作仍需人工在外部平台完成 | 采用并适配 |
| 自建 Git/PR 状态服务 | 最小自研 | 可集中保存交付状态 | 重复 Git 平台的对象、权限与审计能力 | 不采用 |

依据：现有 [Git 交接 Adapter](../../practices/mastra/src/delivery/remote-handoff.ts)、Mastra 原生 suspend/resume；Git 官方 [commit-tree](https://git-scm.com/docs/git-commit-tree)、[push](https://git-scm.com/docs/git-push)。

## 淘汰条件

- 任何方案若允许 Workflow 绕过人工向 `main` 写入，或使 Git 成为 Run 恢复事实源，即淘汰。
- 不能将测试/发布/合并回执锁定候选 commit 的方案不得采用。

## 关键验证

| 假设 | 验证方法 | 结果 | 证据位置 |
| --- | --- | --- | --- |
| 候选代码可在测试前安全进入 Run 分支 | bare 远端回归：隔离 index、路径/基线/漂移校验、重试 | 待本轮回归 | `practices/mastra/tests/code-publication.test.ts` |
| 测试后可绑定同一候选 commit 而不重写源码 | Workflow 回归：质量散列写入既有 codePublication | 待本轮回归 | `practices/mastra/tests/unified-workflow.test.ts` |
| 合并 main 保持人工权限 | Workflow 暂停并校验 PR 回执 | 待本轮回归 | `practices/mastra/src/delivery/deployment.ts` |

## 决策

- 结论：适配。
- 选择方案：开发交付后提交 `code-publication.v2` 候选源码至 `codex/workflow/<RunId>`；独立测试通过后写入同一回执的 `qualityHash`；发布及健康通过后暂停收集人工 `pullRequest` 合并回执。
- 平台拥有：Run 版本绑定、路径和基线校验、候选/质量/发布/PR 回执关联、暂停与恢复语义。
- 外部方案负责：Git 对象与远端传输；Git 平台负责 PR 创建、审批、合并、权限与审计。
- 明确不实现：自动 GitHub API、自动合并 main、CI/CD 调度器或另一套审批数据库。

## 未采用方案及原因

| 未采用方案 | 原因 | 重评条件 |
| --- | --- | --- |
| GitHub API/Actions | 当前未建立凭据、最小权限、Webhook 与生产 CI 运行边界 | 已有受审计服务身份和 CI 制品契约 |
| 自建 PR/版本服务 | 与 Git 平台职责重复，扩大维护面 | 外部平台无法提供必须的私有部署/审计能力 |

## 实施边界

`codePublication` 的 `qualityHash` 在开发候选提交时为空，Git 证据使用 `candidate.json` 与 `status=candidate`，不再使用全零散列；质量门通过后只能由宿主填写为当前 `qualityHash`。它不代表候选 commit 被合并。发布只能消费绑定质量的候选回执。发布和健康通过后，live Workflow 暂停到 `confirm-pull-request-merge`；只接受目标为 `main`、源分支/commit 精确匹配且状态为 `merged` 的人工回执，回执必须含审批人、PR URL、merge commit 与合并后 main HEAD。工作台从同一 Lifecycle 读取并展示这些字段，不建第二状态库。fixture 不要求外部 PR。

## 实施计划

- 受影响路径：`practices/mastra/src/delivery/{contracts,code-publication,deployment}.ts`、`src/mastra/workflows/product-development.ts`、测试、README、数据流文档和本决策。
- 核心数据结构：`code-publication.v2`、`pullRequestReceipt`；均保存于 Mastra Lifecycle，Git 文件仅为投影。
- 遵循的模式：Git Adapter + Workflow Step；Adapter 管 Git 对象/网络，Workflow 管门禁、暂停与恢复。
- 不采用的模式：不得让 Agent 调 Git、不得以文件投影恢复审批、不得以“已推送”表示“已测试/已合并”。
- 依赖与配置：不新增依赖、凭据或环境变量。
- 兼容与迁移：历史 `code-publication.v1` Run 不迁移；只对新 Run 使用 v2 交付语义。

## 验收计划

- [ ] 功能：候选提交发生在测试前，质量通过后绑定质量散列，PR 合并回执后才能 live 最终交付。
- [ ] 结构：候选、质量、发布和 PR 的 source commit/hash 漂移均拒绝；Workflow 不执行 main 写入。
- [ ] 文档与契约：运行 Mastra 相关回归、`openspec validate --specs --strict` 和 `git diff --check`。
- [ ] 剩余门禁：真实业务远端、真实 PR 与实际人工审批/合并另行验收。

## 风险与退出路径

- 已知风险：人工 PR 回执可能延迟；Run 保持暂停且分支保留，不伪造完成。
- 退出路径：停止新 Run 进入 PR 关口，保留既有 Run 分支、回执和 Store 事实；不回写 main。
- 维护责任：Mastra 实践维护者。

## 验收与完成报告

- 验证证据：待本轮相关 TypeScript、回归与 OpenSpec 验证补充。
- 剩余边界：不自动创建 PR、不接入 CI/CD、不验证真实业务 PR。
- 重评条件：接入服务身份、Git 平台插件或受控 CI 时，单独决策自动 PR 创建/状态读取能力。

# 将通过独立测试的候选源码提交到项目远端

- 状态：接受（用户明确要求产研流程生成的业务代码可提交并推送到目标项目远端）
- 日期：2026-11-09
- 负责人：Mastra 实践维护者
- 作用域：Mastra 独立实践，不改变探索主线 OpenSpec 稳定契约。
- 关联决策：[角色资料交接](./2026-11-08-mastra-remote-handoff.md)、[HRM 执行](./2026-11-08-mastra-hrm-execution.md)。本记录扩展二者的候选代码不回库边界。

## 问题、约束与非目标

现有交接只在 product 下保存 candidate-files.json，远端没有可直接检出构建的实际源码改动。成功证据应包含通过独立质量门的候选散列、真实 Git 提交、远端可读取的源码和幂等重试回执。用户工作树、暂存区与当前分支不能被修改；模型没有 Git、shell 或凭据权限。不自动合入主分支，不创建 CI/CD 或替代发布审批，不把合成测试推入业务主分支。

## 候选与依据

| 候选 | 路线与证据 | 结论 |
| --- | --- | --- |
| GitHub API/Actions | 一体化仓库与流水线；需新增认证及调度，当前没有生产 CI 接入 | 本次不采用；有正式 CI 制品需求时重评 |
| Git CLI + 现有 Mastra Step/交接 Adapter | 轻量组合；现有 remote-handoff.ts 已使用 read-tree、hash-object、update-index、commit-tree、push、ls-remote，原生 Step 支持 suspend/resume | 适配；复用 Git 对象、独立 index 和普通非强制 push |
| 自建 patch/版本存储与发布器 | 最小自研路线；重复 Git 已有版本、冲突与网络协议 | 不采用，维护成本没有收益 |

依据：[Git commit-tree](https://git-scm.com/docs/git-commit-tree)、[Git update-index](https://git-scm.com/docs/git-update-index)、[Git push](https://git-scm.com/docs/git-push)；实际锁定 @mastra/core 1.81.0、现有包源码和本地 Git 回归。自有代码只承担权限、版本校验和步骤装配，维护责任归实践维护者。

## 决策与数据边界

在独立测试通过后、发布计划之前增加具名源码回库步骤。项目确认冻结 origin 与基线 commit。宿主读取完整候选，核对研发交付、质量报告和实际检查点，只允许批准任务路径中的新增或修改；不支持删除、链接、检查脚本或依赖配置更改。使用现有开发阶段目标设置，但要求目标与确认的项目一致，拒绝推到另一个资料仓库。未配置同步或旧 Run 无仓库基线时暂停并明确原因。

源码进入 codex/workflow/<根RunId>，与资料提交保持同一历史；基线必须可读取，目标分支中所有候选文件必须与批准基线或已交付源码一致，防止覆盖并发改动。只追加提交，不切换 checkout、不使用用户 index、不强推。回执保存在原生 Lifecycle 中，绑定 sourceHash、qualityHash、baselineCommit、远端 commit 与每个文件散列。重复执行验证既有提交，不回退已推进的分支；失败通过现有 repository-sync 关口重试，无需重跑模型。历史快照新增可选字段，旧独立 CLI/fixture 无远端副作用。

## 实施计划

涉及 development/contracts.ts、intake/repository-project.ts、delivery/remote-handoff.ts、delivery/code-publication.ts、delivery/contracts.ts、主 Workflow、阶段路由及文档。沿用 Adapter 与原生 Step，I/O、权限校验和质量校验分离，不新增依赖或运行数据库。数据为 Zod 约束的新对象，完整候选只存在宿主，模型不能构造 Git 参数。

## 验收计划

- [x] 六类真实模型最终全量复跑18/18通过，strict退出码0；按角色保存评分、源码身份和首轮/修复失败历史，见[独立评测报告](../../practices/mastra/evaluations/native/development-nodes/results-2026-11-09.md)。
- [x] 真实本地 bare 远端：新增/修改源码、可检出执行、保护配置/文件模式、暂存区隔离、非强推、漂移拒绝、失败后幂等重试。
- [x] 原生 Step/Store：未通过质量门不推送，同版本源码推送后保存回执，失败暂停可恢复，版本变化不能借重试放行。
- [x] 类型检查、完整实践281项回归、前后端构建、OpenSpec strict通过；最终源码专项再验见报告。
- [ ] 真实业务远端：HRM GitHub普通分支推送dry-run通过，未实际创建预检分支；实际业务候选写入GitHub尚未执行。合成bare远端不冒充GitHub实测。

## 风险、退出与重评

权限以服务端登记的仓库和原生质量门为界；远端并发、基线漂移拒绝而不自动合并。源码回库不等于功能语义完整或部署成功。删除、可执行文件新增、复杂仓库合并、多仓角色交付、正式 CI/PR 门禁出现时重评。可禁用装配回库步骤并保留 Git 回执和既有分支，无需迁移原生审批事实。实际验证结果追加到独立评测报告。

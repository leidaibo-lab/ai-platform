# 将 HRM 全链路交付资产统一到业务仓库

- 状态：接受（用户指定 hrm、product、testSet、deploy 及业务代码归属）
- 日期：2026-11-07
- 负责人：HRM 项目与 Mastra 实践维护者
- 范围：独立应用实践，不改变探索主线 OpenSpec 稳定契约。
- 演进：补充[完整生命周期](./2026-11-07-mastra-full-delivery-lifecycle.md)和[Workspace](./2026-11-06-mastra-project-workspaces.md)的业务产物与资料目录；历史运行数据保留。

## 问题、约束与非目标

流程已串联，但文档和测试/发布资产主要保存在运行快照，候选目录尚未回接早已确定的 HRM 代码仓库。采用单业务仓库保存可评审的交付资源：product 为产品及技术交接，testSet 为测试资产，deploy 为发布资产；apps/web、apps/api、packages/database 保持已选结构。Mastra 源码、运行数据库及凭据仍在 ai-platform/本地运行环境。

本次建立目录、来源清单、只读业务资料挂载，以及版本化文本/JSON 归档。不扩大执行器权限，不将 .mjs 切片宣称为 pnpm 全栈执行；不自动提交、推送、合并、部署，不读取真实 .env，不运行测试或业务模型 Run。

## 候选与证据

| 候选 | 依据与取舍 |
| --- | --- |
| GitHub 仓库配合 Issues/PR/Actions/Artifacts | 本机 gh 已确认 leidaibo-lab/hrm 为目标仓库、默认 main；本地 HRM 已有 pnpm 工程及未激活的 CI 模板。采用 Git 的业务资产归属，远程执行接线暂缺 |
| Mastra 原生 LibSQL + LocalFilesystem/Workspace + 仓库归档 | 锁定原生文件与 Workflow 能力已用于当前实践。适配：Store 持有运行/审批事实，HRM 保存版本化交付投影，源目录仅只读挂载 |
| 自建文档库、用例平台及发布数据库 | 需增加重复版本/权限/同步能力，当前规模无依据，不采用 |

证据来自本地仓库代码、锁定包与 gh 仓库元数据。网页读取未返回有效正文，未据此声称核实远程实现。未引入依赖或独立项目平台。

## 决策与数据契约

结论：**适配** Git 仓库与原生 Workspace。新增可选 `PracticeConfig.hrmRepositoryRoot`，Studio 显式绑定本地 HRM checkout，默认同级 hrm，可用 MASTRA_HRM_REPOSITORY 指定；验证 origin 等于已授权仓库。仅挂 product/sources 给产品角色；注册 product/testSet/deploy 的 Studio 只读视图。旧 CLI 及评测默认入口保持原来源条件。

来源清单登记原始 brief 的文件 SHA256 与出处；旧 pm-hrm 资料只登记参考位置/版本，不批量复制，不冒充当前范围批准。新的审批事实仍来自本 Run。当前只读 Workspace 没有逐 Run 冻结机制，归档来源散列表示归档时观察到的文件，不宣称生成时读取证明；未来补冻结及实际工具引用。

归档器由宿主调用，Agent 没有新增写权限。投影分别保存产品角色稿/产品正文/审阅记录、开发方案任务与文件散列、测试计划/用例/结果/缺陷、发布计划/范围/回执/健康/回滚。按 Run 与投影 hash 建不可变目录，manifest 最后写入；重复导出验证内容，不覆盖旧版本。写入只在这三个目录，失败显式报错，不伪造归档成功。返回新快照，Hash 和唯一目录规避不同 Run 冲突，不另建审批状态库。

候选代码仍在受限运行目录。交付元数据不等于完整源码档案，不将自动文档导出冒充实际代码回库。需要后续 checkout/基线 commit/批准路径/补丁/PR 适配，再切换开发执行；完成前阻断“HRM 整仓开发已接通”的结论。

## 实施与维护

受影响：hrm 的三个资产目录、README/AGENTS/资产决策；ai-platform 的项目约定、归档 Adapter、Studio 装配及角色暂停点。使用薄 Adapter/原生 Pipeline，Zod 约束输入，不自建 Git 引擎。投影数据有 schemaVersion、repository、runId、mode、stage、hash、文件内容散列；人工批准与外部回执来源保持原标签。保存文件默认不含模型配置/原始响应/数据库。

维护者负责仓库权限、来源登记及归档映射；回退可移除 Studio 配置并继续保留 Store 与已归档文本。HRM 工作树改动不等于提交到远程。大日志/截图/视频、制品和备份存外部资产系统并回写 URI/散列，具体接入后再验证。

## 验收与剩余门禁

- [x] 类型检查、两个仓库 diff 检查、只读 dev API/Workspace 装配核对。
- [x] 目录、来源清单、各阶段导出接线及当前能力说明同步；实际运行另验。
- [ ] 新业务 Run 的实际归档、重启恢复、并发与失败修复验证（本次不运行）。
- 待办：Run 来源冻结/读取证据；项目/迭代/变更统一关联；Git 基线、分支与回库；pnpm/全栈执行；测试脚本生成与用例复用；CI/制品；审批身份；附件/备份/保留策略。

出现多人并发修改、生产发布或远程协作时重评共享 checkout、认证和资产外置方案。当前只完成本地接线与静态检查，不宣称远程发布、业务质量或端到端通过。

## 本轮实际证据

2026-11-07：npm run check 通过；两个仓库 git diff --check 通过；原始 brief 的 SHA256 与 HRM 来源清单一致。运行中的 dev API 仍只注册 productDevelopmentWorkflow，主链未改变；/api/workspaces 返回 hrm-product、hrm-testset、hrm-deploy 以及只读 recruitment-sources，均无 Sandbox。当前为装配和静态检查，没有运行测试、模型业务 Run、实际发布或新业务资产归档验收；没有提交、推送或迁移历史 Run。归档失败会中止对应步骤，失败后恢复与补导出尚待验证。

## 2026-11-08 演进

[远端交接决策](./2026-11-08-mastra-remote-handoff.md)部分替代“不自动提交、推送”的旧限制；审批事实仍由 Mastra Store 拥有。

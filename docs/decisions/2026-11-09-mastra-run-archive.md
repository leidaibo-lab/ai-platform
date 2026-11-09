# 将产研 Run 生命周期投影到项目运行档案

- 状态：接受（用户明确要求先实现运行档案）
- 日期：2026-11-09
- 负责人：Mastra 实践维护者
- 所属区域：应用实践
- 关联 OpenSpec：不涉及探索主线稳定契约；本记录定义实践内部档案契约
- 关联决策：[远端交接](./2026-11-08-mastra-remote-handoff.md)、[资产目录](./2026-11-07-hrm-asset-catalog.md)

## 问题、约束与非目标

换机器拉取代码后看不到另一台机器的 Run。先保存可阅读的生命周期档案，不迁移执行状态、不替代 Mastra Store、不向 Studio 原生最近运行列表注入历史、不部署服务器。用户已确认这一范围。

## 候选与证据

| 路线 | 证据与结论 |
| --- | --- |
| Mastra Store/Studio 一体化历史 | 原生管理快照和恢复，但本机 LibSQL 不随 Git 同步；继续保留为事实源 |
| Mastra 生命周期 Hook + 现有步骤装饰器、Git Adapter、Workspace | @mastra/core 1.81.0 workflows/types.d.ts 的 onStart/onFinish 以及 repository-assets.ts；适配此方案 |
| 自建运行数据库或同步 SQLite | 重复事实所有权，当前无跨机器执行需求，不采用 |

本地安装包源码和声明优先，官方入口 https://mastra.ai/docs/workflows/overview 。onStart 在首次开始执行前调用；onFinish 在成功、暂停、失败后调用，不依赖客户端 watch。空 createRun 尚未开始执行时不算业务创建；首个开始回调记录业务创建。强杀进程不能保证终态回调。

## 决策与数据契约

采用原生 Hook，适配只读档案。product/catalog/runs/<rootRunId>/history/<时间与UUID>.json 保存不可变事件；字段含 schemaVersion、projectId、iterationId（未知为 null）、Run、Workflow ID/档案契约版本、事件范围、步骤、状态、观察时间、平台代码版本和 dirty 标识、产物版本引用、恢复条件。字段显式筛选，不保存正文、异常消息/堆栈、请求上下文或配置。阶段 returned 不等于整个 Run 成功；审批和恢复以 Store 为准。

档案放在业务 HRM 仓库；沿用 codex/workflow/<RunId> 分支及隔离 index。live 下遵循产品阶段远端同步开关，fixture 仅本地。同步目标沿用产品阶段登记目标，可与本地HRM归档目录不同。每次先完成本地不可变写入，再同步；失败只输出固定警告，不能改变业务执行结果或审批。下次事件或显式重试可补推本地积压。失败档案的网络失败不能再改变原来的 Workflow 失败。远端回执仍由既有私有缓存保存。

工作区新增 hrm-run-archives 只读视图，不挂 Agent 工具。档案不是恢复包；跨机器需要获取对应分支文件，普通拉取 main 不会合入每个 Run 的分支。

## 实施与验收计划

- 运行档案模块负责筛选、不可变文件和 Git 同步，步骤 Decorator 负责阶段观察，原生生命周期负责整 Run 状态。沿用安全目录校验和现有 Git Adapter，不增加依赖。
- 固定模型实测原生开始、暂停、恢复、成功、失败；验证同步失败不改写业务结果、积压补推、用户暂存区不变、敏感字段与路径拒绝。
- 类型检查、相关回归、OpenSpec strict、差异检查；文档同步 README、artifact-dataflow、workspaces 与决策索引。

## 风险、维护、退出与重评

维护者负责档案 schema 和 Hook 兼容。Git 与 Store 没有事务，档案是最近观察；强杀可能留下 running，不能据此推断仍运行。时间来自宿主，不证明跨机顺序。归档错误记录固定警告；本地文件失败不能保证保存，需排障。可停用适配器并保留 JSON。多实例并发推进、归档过多或需要实时跨机恢复时重评集中存储和服务部署。真实远端/真实模型业务质量不由 fixture 测试代替。

## 实施验证（2026-11-09）

- 类型检查通过；相关回归25项通过（初版档案3项及现有Git交接、完整产研与跨Store回归22项）。新增实际主流程接线与故障隔离后，档案专项5项通过。
- 原生Hook验证开始、暂停、恢复、成功、失败；真实fixture主链验证产品角色记录、根暂停及同根Run关联。
- 注入网络失败验证本地保留与后续补推集合；既有bare远端回归验证Git对象、幂等与用户index隔离。未向真实HRM远端推送合成Run。
- 运行服务 /api/workspaces 返回200，包含 hrm-run-archives 且 safety.readOnly=true。
- OpenSpec strict通过1项，git diff --check通过。此功能为独立实践内部投影，不修改探索主线稳定契约。
- run:archive sync 命令只补推停止Run的档案，不读写Workflow Store，不调用模型。
- 剩余边界：未迁移家里历史Run，未执行真实模型/远端业务Run；强杀末次Hook缺失、网络延迟和跨机同Run并行仍受限。

- Mastra build 构建通过；先停止空闲开发服务避免输出目录冲突，构建后按原 live 模式与数据目录恢复服务。

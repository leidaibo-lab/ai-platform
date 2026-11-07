# 连接项目、迭代、Run 与统一产物目录

- 状态：接受（用户明确要求关联、自动归档、查看下载和追溯）
- 日期：2026-11-07
- 负责人：Mastra/HRM 实践维护者
- 范围：独立实践，不改变探索主线 OpenSpec；补充 [HRM 资产归属](./2026-11-07-hrm-repository-assets.md)。

## 问题与边界

已有按 Run/阶段/hash 的文件投影，但缺少项目/迭代关联及统一查阅。建立受限本地资产目录，不建设审批平台，不接 Git 回库、CI 或认证，不迁移/伪造历史批准，不运行测试和付费业务 Run。原生 Store 继续保存流程和审批事实，仓库文本仅为可重建投影。

## 候选与依据

| 路线 | 决策依据 |
| --- | --- |
| GitHub Projects/Issues/Releases | 适合后续远程协作，但当前授权是本地连接，不依赖新远程权限或写入远程业务记录 |
| 原生 Mastra API route/Workspace + Git 文件清单 | 采用并适配，锁定 @mastra/core 1.81.0 的 registerApiRoute、Step 和 Workspace 已有实例；复用框架路由与 Store |
| 新建项目数据库和资产平台 | 需额外同步事实及权限，当前规模无依据，不采用 |

结论：适配原生路由和清单投影。项目固定 hrm，启动输入接受 iterationId，未填写明确归 unassigned，不能臆造业务迭代。correlation 含 projectId/iterationId/runId/workflowId，随产品状态、开发输入和后续状态保存；重复 Run 绑定冲突拒绝。旧状态无 correlation 时归未关联历史，不自动创建迭代。

## 实施契约

新增 product/catalog 下项目/迭代/Run 关联记录；每个阶段仍不可变归档 product/testSet/deploy/runs。归档 manifest 增加关联、创建时间和文件散列。统一目录按需从这些 manifest 重建，可按 Run 筛选和下载 JSON 快照，避免共享全局数组写入丢失；相同产物重复归档不新增版本。中途崩溃允许完成标记前的同字节文件补写，冲突拒绝，不声称跨文件/Store 原子事务。

本地 GET API 提供清单、文本预览、单文件下载及 JSON 交付包；只读页面按项目/迭代/Run/阶段查看，Run 链接到原生 Studio。文件必须来自登记 manifest，拒绝路径穿越、符号链接及 hash 不匹配，页面使用 textContent/转义避免执行产物正文；不把模型配置/数据库返回客户端。审批不由此页面提交。

各产品角色、开发步骤、测试和发布关口自动归档。内部子 Workflow 的运行标识不能覆盖 root Run 关联；流水线从输入中的关联获得统一归属。归档失败明确失败，原生 Store 可能已保存其他步骤，需从原生失败步骤恢复，当前不承诺原子恢复。

## 维护、退出与验证

Zod 定义关联、Run 记录、manifest；不可变目录与按需索引贯彻单一职责，薄 Adapter 处理文件 I/O，原生 Step 负责执行。版本沿用现有依赖。新增模块、页面、文档和数据流 SVG/PNG；无新服务/依赖。维护者负责目录兼容和保留策略。可移除页面并直接使用 Markdown/JSON，不影响流程事实；多人并发/海量产物/认证时重评数据库索引和对象存储。

- [x] TypeScript 检查；本地页面、真实空目录与 JSON 包 HTTP 200，非法参数400，未知文件404；来源入口及双仓 diff 核对。
- [x] [数据流转与运行说明](../../practices/mastra/artifact-dataflow.md)，项目约定、输入及 API/下载说明；SVG 渲染 PNG 并视觉核对。浏览器交互未验收。
- [ ] 新业务 Run 自动归档、异常恢复、并发和下载完整性端到端验收（按用户要求本轮不执行测试/业务 Run）。

本地只读查看不是多人权限；历史旧 manifest 明确未关联。页面无数据时显示真实空态，不生成样例冒充业务产物。大附件、实际代码 commit、CI 制品及生产发布继续是原有待办。

## 实际实现

`asset-identity` 定义关联，`asset-files` 负责路径边界，`asset-catalog` 保存不可变关联并按需读清单，`repository-assets` 装饰原生节点，`asset-routes` 和只读 HTML 提供查询、文本和下载。未新增服务或依赖；不维护全局可变索引。目录扫描/下载设本地预算，升级触发条件为多用户、海量产物、大附件或远程访问。代码回库、CI 制品、认证审批与自动部署均未纳入本次实现。

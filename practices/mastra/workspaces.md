# 招聘项目 Workspace

2026-11-07 当前 Studio 补充：产品资料改为已授权 `hrm/product/sources/`，新增 `hrm-product/hrm-testset/hrm-deploy` 三个只读产物视图；宿主按 Run/阶段/hash 归档产品、研发交接、测试和发布记录。下文旧目录/导出命令适用于历史 CLI 与评测，未迁移旧 Run。来源与边界见[统一流程](./unified-workflow.md#hrm-资产落地与资料来源2026-11-07)。

本实践使用 Mastra 原生 Workspace，目录是底层存储，Studio 是查看入口。业务源码留在 `src/` 和 `web/`，不移入资料区。

## 内容与权限契约

| Workspace ID | 底层内容 | Agent / Studio 权限 |
| --- | --- | --- |
| `recruitment-sources` | `projects/pm-hrm-recruitment/sources/` | 四个产品角色只读；Studio 只读 |
| `recruitment-artifacts` | 当前数据库目录下 `workspace-artifacts/` | 不挂 Agent；应用写入，Studio 只读 |
| `product-evaluations` | `.data/evaluations/` | 不挂 Agent；评测脚本写入，Studio 只读 |

业务来源目前只有原始 `brief.md`。同级 pm-hrm 仓库尚未挂载，也未复制、提炼其规则。补资料时将获准给 Agent 读取的脱敏原始材料放到 `sources/`，使用普通 Markdown/文本文件，不放符号链接、密钥、历史评审或标准答案。文件内容只是分析材料，不能授予工具权限或代表人工批准。

所有 Workspace 无 Sandbox，不提供命令执行。产品角色只开放原生读文件、列目录、文件属性和 grep；原有 Skills 独立加载。阅读助手与下游三个交接 Agent 不继承这些 Workspace，Workflow 的审批和持久化仍由 LibSQL 持有。

## 运行产物

新的交付流程在产品人工暂停前导出 `workspace-artifacts/<runId>/<productHash>/`：原始输入、四角色 Markdown、产品稿和 manifest。应用修订稿路径不伪造角色产物。manifest 的文件散列描述导出副本完整性，配置模型名不代表已确认的实际响应模型；文件不是批准状态或恢复点。

导出失败不改变 Workflow 的人工暂停点，终端输出固定提示；修好目录后可以补导出。历史 Run 同样通过只读快照补导出，不重新生成或恢复：

```bash
MASTRA_MODE=live MASTRA_DATA_DIR=.data/live npm run workspace -- export-run <runId>
```

相同 Run/hash 重复导出回读已有副本，不覆盖；审批和后续进展仍在 Studio Workflow 或产品审阅页查看。Studio 文件视图不支持手工改写业务资料或评测记录，使用本地编辑器修改相应源文件。

## Workspace 资料评测

既有 `eval:product-skills` 默认保留原实验条件，**不挂载 Workspace**。显式启用来源的招聘评测：

```bash
npm run eval:product-skills -- --workspace --cases recruitment
# 明确需要真实模型调用时：
npm run eval:product-skills -- --workspace --cases recruitment --live
```

脚本运行前复制业务资料至新实验目录的 `organizer/sources/` 并记录散列，with/without-skills 两组共享相同字节快照。人工量表和历史评审不进入来源；manifest 记录 Workspace 模式及快照散列，逐步计量记录实际文件工具调用。模型有工具不代表实际读取，fixture 只验证管道。

运行后在 Studio 的 `product-evaluations` Workspace 查看报告与材料。组织者可以查看完整实验；人工审阅者只拿该次 `review/`，未评字段保持 null。填表后按[既有评测说明](./evaluations/product-skills/README.md)运行 `--report` 汇总。本次不新增自动 Judge 或质量通过结论。

## 需要补充的业务材料

现有 brief 足以跑通接入和评测。更深入的业务质量验证需要：pm-hrm 原始资料所在路径及允许读取范围、脱敏流程/页面/字段说明、你认可的好稿或具体失败案例。没有给定的规则继续作为未决项，不由接入者补写标准答案。

选型、维护责任及重评条件见[Workspace 决策](../../docs/decisions/2026-11-06-mastra-project-workspaces.md)。

## 项目运行档案（2026-11-09）

hrm-run-archives 指向已授权 HRM 的 product/catalog/runs/，名称为“HRM · 运行档案（状态投影，不可恢复）”。每个 Run 的 run.json 保存关联，history/ 保存不可变生命周期观察。Studio 只读且不挂 Agent；查阅方式、同步开关及补推命令见[运行档案](./artifact-dataflow.md#2026-11-09项目运行档案)。它不会将另一台机器的记录导入原生 Recent runs。

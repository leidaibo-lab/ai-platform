# 招聘项目 Workspace

当前 Studio 使用已授权 `hrm/product/sources/`，并按 Run/阶段/hash 归档产品、研发交接、测试和发布记录。来源与边界见[统一流程](./unified-workflow.md#hrm-资产落地与资料来源2026-11-07)。

主线使用 Mastra 原生 Workspace，目录是底层存储，Studio 是查看入口。业务源码留在 `src/` 和 `web/`，不移入资料区。

## 内容与权限契约

| Workspace ID | 底层内容 | Agent / Studio 权限 |
| --- | --- | --- |
| `recruitment-sources` | `projects/pm-hrm-recruitment/sources/` | 产品经理和产品审查 Agent 只读；Studio 只读 |
| `evaluation-results` | `.data/evaluations/` | 不挂 Agent；研发评测脚本写入，Studio 只读 |

业务来源目前只有原始 `brief.md`。同级 pm-hrm 仓库尚未挂载，也未复制、提炼其规则。补资料时将获准给 Agent 读取的脱敏原始材料放到 `sources/`，使用普通 Markdown/文本文件，不放符号链接、密钥、历史评审或标准答案。文件内容只是分析材料，不能授予工具权限或代表人工批准。

产品资料 Workspace 不提供 Sandbox 或命令执行。产品角色只开放原生读文件、列目录、文件属性和 grep；原有 Skills 独立加载。各阶段按任务装配独立 Workspace，Workflow 的审批和持久化仍由 Mastra Store 持有。研发候选执行环境见下文。

## 运行产物

当前产品团队的产品稿、审查与审批事实由 `productDevelopmentWorkflow` 的 Mastra Store 保存；关联 HRM 时阶段投影由仓库资产适配器归档。文件投影仅用于查看，不能代替审批状态或恢复点。

导出失败不改变 Workflow 的人工暂停点；应用层可在修复目录后按同一 Run/hash 重新导出。相同 Run/hash 重复导出回读已有副本，不覆盖；审批和后续进展仍在 Studio Workflow 中查看。Studio 文件视图不支持手工改写业务资料或评测记录，使用本地编辑器修改相应源文件。

## Workspace 资料边界

产品团队只在正式 `productDevelopmentWorkflow` Run 中读取已绑定的产品资料 Workspace。评测与历史材料不自动暴露给产品经理 Agent 或产品审查 Agent；运行产物仍通过只读 Workspace 视图查看。

## 需要补充的业务材料

现有 brief 足以跑通接入和评测。更深入的业务质量验证需要：pm-hrm 原始资料所在路径及允许读取范围、脱敏流程/页面/字段说明、你认可的好稿或具体失败案例。没有给定的规则继续作为未决项，不由接入者补写标准答案。

选型、维护责任及重评条件见[Workspace 决策](../../docs/decisions/2026-11-06-mastra-project-workspaces.md)。

## 研发候选工作区

研发步骤为当前 Run 的任务候选创建独占 Mastra Workspace，将 `LocalFilesystem` 限定在候选根目录，并绑定禁网、只读执行视图的 `LocalSandbox`。实现 Agent 只拿到 `read_file`、`list_files`、`file_stat` 与 `grep` 等只读 Workspace 工具；`execute_command` 明确关闭。候选写入仍由宿主 `writeFile` 工具按批准任务的精确路径授权，Node/Python 固定检查由项目 Adapter 提供固定可执行文件和 argv，在同一个 Sandbox 内执行；HRM/CIP 使用登记的 Docker 验证器。

Workspace 提供文件与执行环境的组合边界，不接管 Mastra Store 的 Workflow 状态、人工审批、候选检查点或恢复事实。Sandbox 策略版本进入研发执行身份；恢复会重新校验身份和源码检查点，失败后按 Workflow 保存的候选检查点重建独占环境。没有受支持的 OS 隔离后端时，执行失败关闭，不回退到宿主进程。

## 项目运行档案（2026-11-09）

hrm-run-archives 指向已授权 HRM 的 product/catalog/runs/，名称为“HRM · 运行档案（状态投影，不可恢复）”。每个 Run 的 run.json 保存关联，history/ 保存不可变生命周期观察。Studio 只读且不挂 Agent；查阅方式、同步开关及补推命令见[运行档案](./artifact-dataflow.md#2026-11-09项目运行档案)。它不会将另一台机器的记录导入原生 Recent runs。

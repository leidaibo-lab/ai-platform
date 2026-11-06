# 为招聘实践采用 Mastra 原生 Workspace

- 状态：接受（用户授权实现，并确认沿用招聘项目和已有材料）
- 日期：2026-11-06
- 负责人：Mastra 实践维护者
- 所属区域：`practices/mastra` 原生应用实践
- 关联需求：让 Agent 读取业务材料，在 Studio 查看运行产物，并用于可复现评测。
- 关联 OpenSpec：不涉及探索主线稳定契约；实践行为先定义于 [Workspace 契约](../../practices/mastra/workspaces.md)。
- 替代记录：无；细化[固定产品角色](./2026-11-06-mastra-fixed-product-roles.md)的资料读取边界。

## 问题与约束

当前业务 brief、项目评审记录和评测标准分散在文件目录，Agent 只能接收 brief 字符串，不能实际读取源文件。整目录开放会泄露历史评审答案。需要将业务材料、生成稿件与人工评测分开管理，继续由 Workflow/LibSQL 持有事实和人工关口。

沿用 `@mastra/core 1.81.0`、`@mastra/libsql 1.28.0`，不升级依赖、不接入探索 Runtime，不读取根目录凭据。本次不接代码执行、任意仓库访问、向量库、自动 Judge、多人认证或生产隔离；产品角色最多 24 步及人工确认保持有效。

## 候选与证据

| 候选 | 路线 | 依据与取舍 |
| --- | --- | --- |
| Mastra Workspace + LocalFilesystem | 成熟原生组合 | 锁定包 `dist/docs/references/reference-workspace-workspace-class.md`、`reference-workspace-local-filesystem.md` 及类型：Agent 支持独立 workspace，Mastra 自动注册 Agent workspace，`addWorkspace` 支持额外 Studio 视图，`readOnly/contained` 约束文件访问 |
| 保留外部目录 + 自定义读取工具 | 轻量组合 | 可以白名单读文件，但重复原生文件工具和 Studio 展示，后续维护两套入口 |
| 自研项目文件管理与评测平台 | 最小自研 | 需新增存储、权限、页面及运行管理；现有原生能力与专用评测脚本已覆盖本轮需求 |

这是实践内选型，不推导平台采用结论。未采用外部工具和自研平台，因为增加重复基础设施且无当前业务收益；当原生 Workspace 无法表达权限或需要多人远程协作时重评。

## 决策与实施边界

- 采用原生 Workspace/LocalFilesystem。业务资料移入项目 `sources/`，只挂这个目录；不挂项目 README、历史评审、密钥或量表。四个产品角色共享只读来源 Workspace，其他 Agent 不继承它。
- Studio 另注册只读产物视图、只读评测结果视图，不设置全局 Workspace，避免其他 Agent 自动继承历史产物和答案。底层写入者分别为应用导出器和既有评测脚本。
- 产品暂停前导出 brief、四角色稿件、最终稿和 manifest，按 Run/产品 hash 分目录。文件是可重建副本，不能审批或恢复 Workflow。导出失败仅提示固定说明，不破坏原生人工暂停；CLI 可补导出历史 Run。
- 既有配对评测默认禁用 Workspace，以保留旧实验条件。新增显式 Workspace 模式，仅用于招聘案例；运行前冻结来源，记录文件散列，两组使用同一只读快照，量表始终留在评分侧。
- 不将配置模型名冒充实际响应模型，不将导出时来源散列冒充生成时读取证据；实际工具调用由原生 toolResults/逐步计量证明。

## 实施计划与数据结构

修改原生装配、Agent 工厂和产品关口，新增 `src/mastra/project-workspaces.ts`、专用 CLI 和回归；同步项目/评测 README 与文档索引。`ProductAgentOptions.workspace` 为显式实例或 false；默认只读招聘材料。导出器接收已校验 Delivery 投影，版本为 `product-workspace-export.v1`，以 Run ID、产品 hash、mode 与文件 SHA-256 描述不可变稿件；审批事实不迁移。评测沿用现有 TrialResult/manifest，人评未填保持 null。

沿用工厂与薄适配器：Mastra 拥有文件访问、工具循环和流程持久化；实践仅组合目录、白名单工具、投影导出与评测参数。I/O 与生成职责分开，避免重复编排。源码和依赖不复制到 Workspace，历史 Run 不重新生成、不自动批准。

## 验收计划

- [x] 原生工具可读业务资料，拒绝修改、路径穿越、符号链接越界及量表访问。
- [x] 四角色挂载正确，其他 Agent 无 Workspace 工具；真实工具循环与 Workflow 仍停在人工关口。
- [x] 稿件可导出/补导出，重复导出不覆盖旧版本，失败不改变人工状态。
- [x] 默认评测无 Workspace；显式模式冻结同一来源并完成 fixture 执行与待人评报告。
- [x] 后端类型检查、实践回归、Studio/API 展示、OpenSpec strict、diff 检查与文档同步。
- [ ] 真实模型质量提升与人工评测（本次功能回归不代替此项）。

## 风险、退出与维护

所有 Workspace 是本地无认证学习入口，写能力不提供给产品 Agent。新增业务资料须确认不含凭据、个人敏感数据或答案；外部仓库内容仅在用户提供后按原始资料引入，不自行编写规则。运行产物和评测输出保持本地忽略。导出副本可能滞后，事实以原生库为准；失败后用 CLI 重建。

维护者为 Mastra 实践维护者。退出时移除挂载/导出适配器，保留原生 Workflow 库与 Markdown/JSON；brief 的新路径保留 Git 历史。远程存储、多项目权限、代码执行、大样本或自动评分需求触发重新评估。

## 验收与完成报告

2026-11-06，Node.js 24.19.0，锁定依赖不变：

- `npm run check` 通过，`npm test` **46/46** 通过；新增 4 项回归覆盖只读/路径/符号链接/答案隔离、四角色实际原生文件工具调用与导出、人工作用域、幂等/篡改检测及导出失败隔离。原有跨进程恢复、旧快照和产品审批回归继续通过。
- `npm run eval:product-skills -- --workspace --cases recruitment` fixture 完成两组各一次，均为 ready-for-review；资料快照 SHA-256 已登记，两组 reviewed=0，质量指标为 null。输出位于本地忽略目录 `.data/evaluations/product-skills-2026-11-06T02-14-34-165Z/`；未调用真实模型。
- Studio `/api/workspaces` 返回三个只读 Workspace，均无 Sandbox。浏览器实际打开 `recruitment-sources` 的 brief，确认正文可读、资料区只有业务输入；`product-evaluations` 显示本次结果。
- 文档所记招聘 Run 不在当前 live 库中，未伪造或重建其历史。用当前已有工单标题 Run `53d9c11d-5a10-4c43-8269-42996fa71928` 验证 CLI 补导出；导出前后仍为 suspended，另外两条历史 Run 状态不变。旧稿无四角色证据时只导出实际存在的稿件。
- `openspec validate --specs --strict` **1/1** 通过；本次不修改探索主线契约。文档索引、实践说明、业务来源路径与评测入口同步；`git diff --check` 通过。

实现仅组合原生文件/工具/注册能力，未采用自定义文件工具或另建评测平台。实践自写范围为目录装配、草稿导出与显式评测参数。真实模型资料使用、产品质量收益、人工评分及真实代码执行仍待验收；维护与重评条件沿用上节。

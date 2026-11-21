# 运行配置与 Workflow 资源归属

## 运行配置指南

本节承接根 README 的运行细节。应用配置由 `src/mastra/config.ts` 读取；根 `.env` 和进程环境生效，进程环境优先。下文资源盘点 JSON 与接入定义不因此成为运行配置。

### 模式、模型与数据目录

`MASTRA_MODE` 默认 `fixture`；显式设为 `live` 才调用真实模型。live 必须设置 `OPENAI_API_KEY` 与 `MASTRA_MODEL`，可配置 `MASTRA_BASE_URL`。`MASTRA_PORT` 默认 4111，修改需同步工作台代理。`MASTRA_DATA_DIR` 默认 `.data`，可使用相对根目录或绝对路径；fixture/live 使用隔离目录。

按角色覆盖模型的变量为 `MASTRA_PRODUCT_MODEL` 和 `MASTRA_DEVELOPMENT_MODEL`，示例见 [`.env.example`](../.env.example)。产品经理和产品审查使用产品覆盖；研发及评审/委派使用开发覆盖；其他角色和评测裁判使用默认模型。覆盖缺省或为空时回退默认模型，端点与凭据沿用公共配置，代码不内置业务模型名称。配置重启后生效；切换开发模型可能触发旧 Run 执行身份拒绝，不能强行绕过。

真实模型可用性先通过 `npm run smoke:live` 核实终答与真实工具调用，该命令产生费用；随后可用 `MASTRA_MODE=live MASTRA_DATA_DIR=.data/live npm run dev` 启动。服务仅供本机使用；真实模型质量仍需专项验收，不因冒烟通过就放行业务。

### Nacos 产品方法资源

默认启用 Nacos。按 [环境变量样例](../.env.example) 配置 Nacos 3.3 服务、命名空间、只读账号及明确的资源名称和版本，缺配置时启动失败。无资源配置的 fixture 或构建进程可显式设置 `NACOS_RESOURCES_ENABLED=false`，不会替其他进程关闭资源校验。

资源需先在 Nacos 审核发布；应用不负责发布。Run 初始化保存产品 Prompt、Skill 正文、references 和 SHA-256；产品角色从冻结快照装配，不额外叠加整套本地产品方法。调用前复核原服务同版本可访问且内容未变，撤销、下线、注册中心不可用或内容漂移时停止调用，不切换到“最新版本”。远端资源不授予工具和审批权限。

| 配置 | 绑定含义 |
| --- | --- |
| `NACOS_REVIEW_PROMPT_NAME` / `NACOS_REVIEW_PROMPT_VERSION` | 为独立产品审查指定 Prompt；缺省共用产品 Prompt |
| `NACOS_ADDITIONAL_SKILLS` | 额外 Skill 名称与精确版本数组；最多 127 个额外 Skill，冻结内容合计最多 8 MiB |
| `NACOS_REVIEW_SKILLS` | 审查角色使用的已登记 Skill 名称子集；未配置共享全部，空数组不加载 Skill |

这些资源进入 Run 和审批身份，变更只影响新 Run 的资源选择。旧 Run 无快照时保留本地兼容；有快照时恢复需原服务、原版本和可用凭据，切换地址可能阻断恢复。研发业务阻塞回流调用产品角色仍使用原产品快照；研发、测试等自身方法未全面迁入 Nacos，MCP 暂未接入。

此前本地 113 项产品方法不自动装入新 Run；如需使用，先治理并发布，再配置名称与版本。资源准备和候选清单见 [产品资源](../nacos-resources/product/README.md)与[角色清单](../docs/application/agent-resource-inventory.md)，真实服务记录见 [live 验证](../docs/application/nacos-live-run-findings.md)。候选包/模拟服务验证不能代替目标环境授权与业务质量验收。

### 工程登记与远端同步

`MASTRA_ENGINEERING_PROJECTS` 登记多项目，与 `MASTRA_ENGINEERING_PROJECT` 单项目互斥；客户端只选择 ID，Run 初始化冻结绑定。字段及固定 commit 的文件要求见[项目登记](../docs/application/harness-architecture.md#登记业务工程项目)。未登记时默认 HRM checkout 来自 `MASTRA_HRM_REPOSITORY` 或同级 `hrm`，origin 须匹配配置要求。

远端同步设置按阶段生效；登记项目固定使用自身绑定仓库，历史入口仍使用原目标字典和设置。`MASTRA_REMOTE_SYNC_TARGETS` 仅为历史目标初始字典，不应作为多项目 Run 的仓库回退。管理页不接收凭据，服务器验证 checkout 和 origin。live 同步与 MR 使用明确授权的宿主 Git/GitHub CLI 会话，fixture 不推送真实远端。详细失败重试、分支回执和档案补同步见[数据流说明](../docs/application/artifact-dataflow.md)。

## 资源盘点与运行配置的区别

[workflow-resources.json](./workflow-resources.json)登记当前完整产研流程的资源归属、生产消费关系、版本绑定、代码配置入口和已知缺口。它是当前代码的审计快照，**没有被运行时加载**，修改它不会改变Agent权限、流程、预算或审批。

## 当前判断

- **事实归属基本收敛**：原生Workflow/LibSQLStore拥有运行及审批事实；批准产品、任务、测试和交付证据以版本/hash绑定。HRM目录保存交付投影，不作为第二审批事实库。候选代码仍由受限执行目录持有，Workflow持有对应检查点及交付版本。
- **解耦尚不完整**：产品角色接收前序全文，开发与测试角色仍依赖StateV2/Lifecycle的大块状态。执行I/O已有Port与逐步骤作用域，职责也已分开，但不能据此宣称角色间已通过最小交接契约完全解耦。
- **配置尚未统一**：环境配置有`readConfig`入口，角色、方法、预算、引用域和团队限制仍分散在各自代码中。JSON登记这些权威入口，不再复制一套权限/预算数值。
- **工程版本与交付**：显式登记项目固定 Git commit，资产关联随项目和 Run 保存。默认 HRM 继续使用兼容资料入口。当前默认交付保存经核验的 MR 回执。历史部署试点的发布证据由人工回填。见[业务工程登记](../docs/application/harness-architecture.md#登记业务工程项目)。

“单一性”指每种事实和配置有明确权威来源，允许不可变快照和只读投影。它不意味着所有资源放入一个巨型文件，也不意味着共用一个可变对象。上游Agent不能直接修改下游批准、工具注册或执行环境。

## 字段及使用边界

- `resources`描述逻辑生产者/消费者，不是可执行节点定义；`contract`定位当前Zod/代码契约。
- `configurationOwners`定位当前配置权威入口；`versionBinding`是绑定机制说明，不是需要执行的表达式。
- `gaps`保留未完成边界；`nextRuntimeDesign`仅是后续方案要求。
- `evidenceFileHashes`记录生成清单时17个依据文件的字节散列。依据变化应重新核对清单，不直接把旧清单当作当前运行证据。
- 清单不读取环境、不包含密钥；不是JSON Schema，不会创建第二份运行状态、批准事实或角色权限来源。

若继续接入真实配置，优先沿用Mastra原生工厂：声明资源和合法引用，装配时做交叉校验，按Run冻结配置hash，并将各角色输入投影为最小契约。是否集中角色、方法或预算需逐项决定，避免配置文件与代码同时拥有同一规则。当前未实施这一重构，也没有新增运行时行为。


## 接入定义

真正接入前的规则已集中在[资源接入规范v1](./runtime-resource-contract.md)，配套[配置示例](./workflow.runtime.example.json)和[方案决策](../docs/decisions/2026-11-07-mastra-resource-contract.md)。覆盖唯一权威、加载与交叉校验、Run冻结/恢复、13种角色输入、版本迁移和RC01–RC14验收。定义已形成，加载器、冻结存储与DTO投影尚未实现；示例不是当前可用运行配置。

## 当前可执行的资料读取配置

[material-policy.ts](./material-policy.ts)是已经接入运行时的局部配置，与上面的资源盘点JSON不同。服务端构建时导入；修改后检查并重新发布，不支持热更新。`version`随策略语义调整递增；当前只记录在定位工具结果中，尚不是全Run配置冻结机制。运行中更改配置可能影响下一次恢复，已有Run应保持同版本部署。

| 字段 | 用途 | 默认 |
| --- | --- | --- |
| `chunks.strategy` | 换行优先分片`paragraph`，或固定长度`fixed` | paragraph |
| `chunks.chars` | 每片最多UTF-16字符数；不得超过读取单片上限 | 3000 |
| `chunks.pageSize` | 每次返回片段目录数量 | 12 |
| `chunks.previewChars` | 每片预览，不是业务摘要 | 80 |
| `chunks.responseBytes` | 单次目录条目字节上限 | 12000 |
| `reading.materialBytes` | 大于此值的材料折叠为引用 | 3000 |
| `reading.readChars` | 单次正文读取字符上限 | 6000 |

只调整分片参数就能改变读取方式，无需改Agent或Workflow。更换算法时修改`src/delivery/material-chunks.ts`，保持`offset/end/bytes/preview`契约；它不访问文件、不调用模型、不改审批。任务资料注册和工具适配由`task-context.ts`负责，执行上下文由`src/mastra/context-memory.ts`装配原生 Memory；`context-budget.ts`仅保留历史故障Schema与旧档位字段兼容，不再执行预算门槛。暂停/确认仍由原生Workflow负责。配置不得扩大读取目录或写权限。

调用示例：先`handoff_locate({id, query:"权限"})`，从返回片段选取相关范围，调用`handoff_read({id, offset, length:end-offset})`；有`nextCursor`时可继续定位。有跨片段关键词时同时读取相邻片段。必要的完整核对仍应顺序读取全部相关片段，不能凭关键词未命中或预览声称已核实。

目录预览与正文不再消耗累计资料额度，初始目录和模型消息不再按UTF-8字节阻断。保留分页、单次返回大小及固定版本引用，避免默认展开无关资料。

## 原生上下文配置

`src/mastra/context-memory.ts`是角色 Memory 的唯一装配入口，使用 Mastra 原生观察、反思与上下文溢出恢复。默认同步观察阈值为24000消息token，反思阈值为12000观察token，估算由框架完成；无需资料升档确认。Observer/Reflector沿用当前角色模型与出口。每次执行的宿主UUID隔离thread/resource，失败重试从保存输入重新开始，不将失败片段带入新执行。fixture保持离线，独立原生Mock用例验证压缩与隔离。原始消息属于Mastra Store，不代替Workflow批准事实。

这些阈值不代表上游窗口的精确容量，压缩也不保证零信息损失；首次系统提示或单条输入过大、provider不兼容、观察模型失败仍可能使当前调用失败。应核实实际模型窗口及长材料业务质量，不通过恢复资料字节门槛掩盖问题。

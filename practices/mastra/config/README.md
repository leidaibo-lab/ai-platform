# Workflow 资源衔接清单

[workflow-resources.json](./workflow-resources.json)登记当前完整产研流程的资源归属、生产消费关系、版本绑定、代码配置入口和已知缺口。它是当前代码的审计快照，**没有被运行时加载**，修改它不会改变Agent权限、流程、预算或审批。

## 当前判断

- **事实归属基本收敛**：原生Workflow/LibSQLStore拥有运行及审批事实；批准产品、任务、测试、发布证据以版本/hash绑定。HRM目录保存交付投影，不作为第二审批事实库。候选代码仍由受限执行目录持有，Workflow持有对应检查点及交付版本。
- **解耦尚不完整**：产品角色接收前序全文，开发与测试角色仍依赖StateV2/Lifecycle的大块状态。执行I/O已有Port与逐步骤作用域，职责也已分开，但不能据此宣称角色间已通过最小交接契约完全解耦。
- **配置尚未统一**：环境配置有`readConfig`入口，角色、方法、预算、引用域和团队限制仍分散在各自代码中。JSON登记这些权威入口，不再复制一套权限/预算数值。
- **资料唯一版本尚有缺口**：HRM来源资料未逐Run冻结并核实实际读取；资产归属项目固定hrm，执行项目ID另有作用；外部发布证据仍由本地人工回填。

“单一性”指每种事实和配置有明确权威来源，允许不可变快照和只读投影。它不意味着所有资源放入一个巨型文件，也不意味着共用一个可变对象。上游Agent不能直接修改下游批准、工具注册或执行环境。

## 字段及使用边界

- `resources`描述逻辑生产者/消费者，不是可执行节点定义；`contract`定位当前Zod/代码契约。
- `configurationOwners`定位当前配置权威入口；`versionBinding`是绑定机制说明，不是需要执行的表达式。
- `gaps`保留未完成边界；`nextRuntimeDesign`仅是后续方案要求。
- `evidenceFileHashes`记录生成清单时17个依据文件的字节散列。依据变化应重新核对清单，不直接把旧清单当作当前运行证据。
- 清单不读取环境、不包含密钥；不是JSON Schema，不会创建第二份运行状态、批准事实或角色权限来源。

若继续接入真实配置，优先沿用Mastra原生工厂：声明资源和合法引用，装配时做交叉校验，按Run冻结配置hash，并将各角色输入投影为最小契约。是否集中角色、方法或预算需逐项决定，避免配置文件与代码同时拥有同一规则。当前未实施这一重构，也没有新增运行时行为。


## 接入定义

真正接入前的规则已集中在[资源接入规范v1](./runtime-resource-contract.md)，配套[配置示例](./workflow.runtime.example.json)和[方案决策](../../../docs/decisions/2026-11-07-mastra-resource-contract.md)。覆盖唯一权威、加载与交叉校验、Run冻结/恢复、13种角色输入、版本迁移和RC01–RC14验收。定义已形成，加载器、冻结存储与DTO投影尚未实现；示例不是当前可用运行配置。

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

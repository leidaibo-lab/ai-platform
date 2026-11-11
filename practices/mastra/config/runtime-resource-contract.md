# Mastra 资源配置与角色交接接入规范 v1

状态：整体仍为定义稿，示例未被运行时加载。2026-11-11角色版本/恢复子集由[原生角色版本决策](../../../docs/decisions/2026-11-11-mastra-stored-role-runtime.md)及`openspec/specs/mastra-role-resources/spec.md`取代：Agent/Skill内容归Mastra原生版本库，应用只存Run版本引用与可信制品绑定，历史Run不兼容。下文旧版兼容、整包内容自存方案不再作为该子集实施要求；预算统一、13种DTO、业务资料快照等仍属未实施设计，不因角色版本接入而宣称完成。[原始决策](../../../docs/decisions/2026-11-07-mastra-resource-contract.md)。

## 1. 唯一归属

| 内容 | 唯一权威 | 可配置部分 | 代码强制部分 |
| --- | --- | --- | --- |
| 角色资源声明 | 生效的`workflow.runtime.json`（拟新增） | 登记ID、角色卡/方法/工具/投影引用及预算 | 注册表内ID、合法组合、宿主能力上限 |
| 角色卡、方法正文 | 版本化文件及来源锁 | 选择登记版本 | 文件完整性、只读、禁止热替换 |
| 输入输出数据结构 | Zod契约注册表 | 选择`contractId`，不定义字段表达式 | 字段、类型、引用域、权限和版本校验 |
| 工具能力 | 宿主工具注册表与执行Adapter | 选择能力子集 | 工具实现、可写路径、沙箱、禁止任意命令 |
| Run与审批事实 | Mastra原生Store | 无 | 原生步骤保存、hash绑定、恢复校验 |
| 初始资料与候选源码 | 冻结来源清单、Run候选目录 | 选择登记来源profile | 文件读取/修改范围、逐版本hash |
| 模型传输与凭据 | `readConfig`及服务端环境 | 登记模型profile引用 | 凭据加载、脱敏、模型/端点身份 |
| 审计清单、导出、Studio展示 | 由生效配置/事实派生 | 无独立默认值 | 单向生成，不反向覆盖运行事实 |

**同一个运行参数只能有一个默认值来源。** 生效配置中的预算为必填，工厂不得再有`?? 12`等兜底；代码仅保留不可配置的安全上限和关系约束。上限是宿主能力，不是另一份运行默认值。例如`maxCalls=48`在配置中唯一声明；代码允许范围为1–72，不能把配置缺失自动解释为72。

目前`stateV2Schema.maxCalls=72`、`teamSchema.maxParallel=3`及工厂内常量仍存在；接入时必须一并迁移为“有界整数 + 冻结配置一致性校验”。迁移完成前不得让新配置与旧常量同时影响同一Run。产品角色顺序、审批路由、质量门和失败恢复属于代码状态机，不开放为配置脚本。

## 2. 输入配置与加载结果

拟新增的生效文件`workflow.runtime.json`使用`mastra-resource-config.v1`；当前[示例](./workflow.runtime.example.json)只供评审，其中所有版本ID都是拟定义的注册表项，不能宣称现有加载器已能解析。`workflow-resources.json`继续是审计清单，不改作运行配置。

配置必填字段：`schemaVersion`、`id`、`workflowRef`、`sourceProfile`、`modelProfile`、`budgets`、`roles`。禁止未知字段、null、重复JSON键、重复角色或方法/工具ID；字符串必须非空，ID仅限宿主登记值。对象字段不做任意模板插值，不能携带函数、动态import、URL、绝对路径、shell或JSONPath。`id`只作可读标签，不能代替内容hash。

`roles[]`字段固定为`id/cardRef/inputContract/outputContract/methodRefs/toolRefs/maxSteps`；输入输出契约及角色卡均为登记版本ID。方法ID可引用冻结方法集合，但不得通过路径跳出来源锁。预算字段固定为`developmentMaxCalls,maxParallel,maxDelegationsPerTask,delegationDepth,maxReworks,faultRetries`；前四项为正整数，后两项可为0。`developmentMaxCalls`计开发及QA返工中的父/子/评审调用，不把产品、测试和运维调用混入同一未定义口径；这些角色另按冻结maxSteps及有界调用次数计账。项目范围确认只能将maxReworks收紧，不得扩大配置上限。环境只选择本地配置文件位置和凭据/传输profile，不覆盖角色、权限或预算。配置路径由服务端启动参数提供，不从Workflow客户端输入接受。

拟定义的宿主类型（以未来Zod定义为唯一类型来源，不另写一套手工JSON Schema）：

| 对象 | 必填字段 | 所有权与变更 |
| --- | --- | --- |
| `LoadedResourceConfig` | `schemaVersion,id,workflowRef,sourceProfile,modelProfile,budgets,roles` | 配置加载器拥有；严格解析后不可变 |
| `ResolvedResourceBundle` | `config,workflowVersion,registryVersion,adapters,contracts,cards,methods,sourceProfile,modelIdentity` | 装配器解析登记引用，含资源版本及内容hash；不含凭据 |
| `FrozenRunResources` | `version,runId,configHash,bundleHash,bundle,sourceSnapshotHash,createdAt` | 初始化步骤保存；`createdAt/runId`不计入配置内容hash；冻结后不可编辑 |
| `ResourceRef` | `resourceId,version,hash,contractId` | 引用已提交上游产物，不接受Agent自行声明已批准 |
| `AgentInvocation` | `runId,roleId,taskId,round,bundleHash,inputContract,inputHash,resourceRefs,payload` | 宿主创建；`taskId`仅无任务角色为null，其余非空；payload按角色投影 |
| `InvocationEvidence` | `invocationId,roleId,bundleHash,inputHash,outputContract,outputHash,toolEvidenceRefs,usage` | 宿主记录；工具事实不从模型自报生成；未知usage显式null |

任何配置资源缺失都失败关闭，不允许从源码常量、旧审计清单或当前环境临时补齐。

## 3. 加载与交叉校验顺序

```text
服务端指定配置文件
  → 严格JSON解析（含重复键拒绝）
  → Zod结构校验
  → 从固定注册表解析资源、版本和内容hash
  → 角色/权限/契约/依赖/预算交叉校验
  → 生成不可变ResolvedResourceBundle
  → Run初始化冻结并由原生Store提交
  → 各步骤从Run快照读取并投影角色输入
```

装配校验不能只检查文件存在。以下约束全部通过才可注册新配置Workflow：

1. 角色集合与代码定义的Workflow职责一致，无缺项、重复或未知角色；动态团队实例只能选择冻结的实现角色模板。
2. `cardRef/methodRefs/toolRefs/contracts/profiles`全部可解析，注册表版本、Zod契约版本、Adapter版本与锁定依赖兼容；契约ID不能指向任意模块路径。
3. 每项资源有唯一权威生产者/状态所有者；只读投影不登记为第二生产者。正常依赖不得引用后续阶段；QA返工只允许代码已定义的循环，配置不能新增环。
4. 角色工具集合是宿主该职责允许集合的子集；任务写路径再与已批准manifest相交。父任务只有委派能力，子成员只有已分配读写能力，不能继续委派。schema字段不构成授权。
5. 输入投影仅声明需要的资源，不携带Store、执行器、凭据、完整StateV2/Lifecycle或隐藏验收答案；所有必填上游资源必须已提交且满足同版本批准。
6. `requirementRefs/acceptanceRefs`只能引用批准产品锚点，`contextRefs`只能引用已冻结并读取的文件，`verificationRefs`只能引用登记检查。模型提示词的分组从同一契约注册表派生，不手写另一份引用域。
7. 预算不超过宿主硬上限：开发总调用72、并行3、每任务委派3、委派深度1；角色步骤上限按宿主能力登记（产品24、开发12、测试/运维1）。这些是当前能力上限，调整须有独立证据。子调用、失败与返工都计入原Run预算，重新规划不能清零。
8. 所选工具组合在分支预算内至少能完成一次合法父子调用；预算不足直接报配置错误，不在运行中静默降级为假完成。
9. 来源manifest不能包含密钥、符号链接、隐藏文件或越界文件；文件列表与实际字节一致。模型profile可解析且不把key写入bundle。
10. 不支持的旧版本、重复配置权威、冲突的路径责任、缺少只读评审职责均拒绝。错误为固定`stage/code/fieldPath`，不回显值、请求或原始文件内容。

错误域定义：`CONFIG_PARSE`、`CONFIG_SCHEMA`、`RESOURCE_UNRESOLVED`、`CONTRACT_INCOMPATIBLE`、`ROLE_SET_INVALID`、`PERMISSION_EXPANSION`、`RESOURCE_OWNERSHIP_CONFLICT`、`DEPENDENCY_INVALID`、`BUDGET_INVALID`、`SOURCE_INTEGRITY`、`FROZEN_BUNDLE_MISMATCH`。不将任意异常message充当可持久化错误码。

## 4. Run级冻结、hash与恢复

**先冻结资源，后调用第一个产品Agent。** 初始化步骤保存bundle和输入资料快照清单，提交成功后才能进入产品步骤；不是等产品或技术批准时才冻结。

- `configHash`：对严格解析的业务配置作确定性JSON序列化后SHA-256。对象键按Unicode码点排序，无空白UTF-8；只允许字符串、布尔、null（仅宿主快照中的可空字段）、安全范围整数、数组、普通对象；拒绝undefined、NaN、浮点及负零。数组默认保留顺序；`roles`按id排序，`methodRefs/toolRefs`按ID排序且拒绝重复；其他语义为集合的字段在schema明确后排序及去重校验，不允许通用序列化器自行重排任务执行序列。
- `bundleHash`：同一规则计算`{bundleVersion,configHash,workflowVersion,registryVersion,adapterVersions,contractVersions,cardHashes,methodHashes,sourceProfileVersion,modelIdentity}`。adapterVersions必须含构建内容hash并覆盖prompt投影/渲染实现，不能只用可随意复写的版本标签。代码与生成提示词必须使用同一规范化函数；不得复用当前只做JSON.stringify的`developmentHash`而假定字段顺序稳定。
- 模型身份包含请求模型ID、归一化端点身份hash和协议版本；凭据本身不参与hash，允许密钥轮换。数据库地址、端口、临时路径、时间、Run ID不参与bundleHash。实际响应模型ID另记证据，不能取代请求身份。
- 产品资料在调用前复制到Run专属只读快照，记录文件相对路径、字节hash、sourceSnapshotHash；四产品角色只读快照，不再读可变的原仓库资料。导出时观测manifest不能替代生成时来源。源码初始快照到项目范围确认时才取得，其hash单独绑定`scopeApproval`，不回写或重冻初始化配置。
- 原生Store保存冻结manifest、配置声明及可恢复的角色卡/方法内容或其不可变归档引用；引用必须可校验且在整个Run保留期可用。不能只存路径/hash后仍读取已更新文件。文件投影失效时从原生提交事实恢复，不生成第二审批库；没有可核实的冻结内容则停止。
- 每次调用、审批、故障接续、QA返工和最终交付都绑定`bundleHash`。产品批准绑定`productHash + bundleHash + sourceSnapshotHash`；方案批准在既有绑定上增加`bundleHash`；质量/发布hash沿同版本链传递。
- 恢复读取Run已冻结bundle，不重新合并当前配置。不要求当前默认配置与旧Run相同；但宿主必须仍支持该冻结版本和资源hash。兼容则按旧bundle继续，不兼容则`manual-attention`，不能悄悄换方法或模型。
- 活跃Run不接受原地改配置。变更配置只影响新Run，建立`supersedesRunId`及原因；不能继承旧批准。紧急安全撤销只允许宿主阻断继续执行，不静默重写冻结bundle或伪装既有调用已取消。
- 不承诺新增跨实例原子操作。配置冻结写入失败不得进入首个Agent；快照提交前产生的暂存文件标记未提交，重试只回读同Run提交结果并清理未提交副本。

## 5. 逐角色最小输入契约

所有角色payload是宿主从事实状态创建的独立不可变快照；JSON结构用strict schema拒绝额外字段。内部编排可持有StateV2/Lifecycle，模型和角色工具闭包只持有本角色投影与限定Port，不持有原Store或整份状态。

共同元数据是`AgentInvocation`信封。默认payload不含审批人的身份/自由评论、完整历史或其他角色系统指令。必需上游资源缺失时停止；可选来源没有时使用显式空数组，不能用undefined混同“未验证”。所有读取限于本次scope，工具扩展读取也必须登记证据。

| 角色模板 / inputContract | payload允许字段 | 输出契约与消费者 |
| --- | --- | --- |
| 总产品 / `product-coordinator.input.v1` | `brief,sourceRefs,reworkFeedback` | `product-work.output.v1`，供需求梳理 |
| 需求梳理 / `product-clarification.input.v1` | `brief,sourceRefs,coordination,reworkFeedback` | 同上，供闭环 |
| 产品闭环 / `product-closure.input.v1` | `brief,sourceRefs,clarification,coordinationDecisions,reworkFeedback` | 同上，供写作 |
| 产品写作 / `product-writing.input.v1` | `brief,sourceRefs,clarification,closure,coordinationDecisions,reworkFeedback` | `product-document.output.v1`，供产品审批 |
| 上下文 / `context.input.v1` | `approvedProduct,requirements,projectScope,fileManifest` | `context.output.v1`，宿主校验后保存ProjectContext |
| 架构 / `architect.input.v1` | `approvedProduct,requirements,context,projectScope,referenceGroups,priorBlockingFindings` | `plan.output.v1`，供组队/就绪/方案审批 |
| 就绪 / `readiness.input.v1` | `approvedProduct,requirements,context,plan,taskPackages,referenceGroups` | `assessment.output.v1`，供就绪门；不含作者的自评结论 |
| 任务负责人 / `implementation-owner.input.v1` | `task,requiredContracts,contextRefs,dependencyOutputs,assignedFileRefs,findings,remainingTaskBudget` | `implementation-summary.output.v1`及真实委派证据；无直接写工具 |
| 子实现成员 / `implementation-member.input.v1` | `delegatedTask,requiredContracts,contextRefs,assignedFileRefs,relevantDependencyOutputs,findings` | 同上及本任务补丁证据；不含兄弟任务私有内容 |
| 自检 / `self-check.input.v1` | `registeredChecks,sourceHash,taskCompletionSummary` | `self-check-summary.output.v1`；实际进程CheckEvidence由宿主生成 |
| 代码评审 / `reviewer.input.v1` | `approvedProduct,requirements,approvedPlan,diff,sourceRefs,checkEvidence,unresolvedFindings,referenceGroups` | `assessment.output.v1`；修复结论引用旧发现和新证据，无写工具 |
| 独立测试 / `testing.input.v1` | `approvedProduct,requirements,approvedContracts,sourceRefs,registeredChecks,priorQualityFindings` | `test-plan.output.v1`；不提供开发“已通过”自评作为测试结论 |
| 运维方案 / `operations.input.v1` | `productReleaseSummary,developmentDeliveryRef,qualityApprovalRef,sourceHash,releaseConstraints` | `release-plan.output.v1`；不含部署凭据，无远程执行能力 |

实现负责人/子成员是模板，按已批准任务的frontend/backend/infrastructure职责实例化；模板不能绕过项目roles白名单或更换任务责任。

表内所有object/ref字段都必须细化到注册schema，不允许`Record<string,unknown>`或任意嵌套状态透传。批准事实用宿主校验后的`{resourceId,hash,decision}`摘要，业务正文来自对应不可变产物；Agent不得自填批准事实。`sourceRefs`只允许本角色授权的只读读取。产品角色仍能按需读取冻结来源，保留依据追溯能力。

`requirements`只包含批准版本的锚点、行号、原文与hash；`referenceGroups`从同一资源引用校验器派生。`priorBlockingFindings/findings`按任务与依赖闭包筛选，保留原发现ID、来源报告hash、证据引用和处理状态；禁止仅转述后丢失版本。`requiredContracts`只包含当前任务实现需要的接口与约束，不传整个计划和无关任务内容。模型输出不得写Run状态，宿主将通过输出schema与引用校验的结果合入新快照。

## 6. 接入步骤与迁移边界

1. 契约先行：实现strict Zod配置、冻结bundle、Invocation及13种输入/输出注册契约；类型与可发布JSON Schema从同一Zod生成。配置示例不作为测试标准答案。
2. 装配：实现固定资源注册表、唯一加载器、引用域校验器和确定性hash；所有新工厂只接收ResolvedBundle或FrozenBundle，不自己找默认值。
3. 冻结：在新的版本化主流程初始化步骤保存资源和来源快照；提出`development-state.v3`/`delivery-lifecycle.v2`及带bundleHash的批准格式。旧v2数据、hash和入口不原地迁移。Studio保持一个新入口，旧Run显式交给原版本工厂读取；旧版本资源不可用则只读查看或停止，不补造freeze事实。
4. 投影：依次接入产品→上下文/架构/就绪→团队/自检/评审→测试/运维；运行入口不得同时存在“整状态”和“新DTO”的静默回退路径。
5. 收敛：删除新入口内旧角色默认值及手写引用域说明，展示清单从解析后的bundle生成；历史兼容代码单独标明适用版本。
6. 验证后启用新Workflow内部ID`product-development-resources-v1`，保留Studio注册键`productDevelopmentWorkflow`。回退只影响新建Run路由，不能用旧工厂继续新Run。

建议实现位置：`src/mastra/resource-config.ts`（加载/注册适配）、`src/resources/contracts.ts`（唯一Zod契约）、`src/resources/freeze.ts`（冻结/hash）、`src/resources/projections.ts`（角色DTO）以及现有app/workflow/Agent工厂接线。以上文件是计划，当前尚不存在。维护者为Mastra实践维护者；不增加平台服务、跨框架协议或新的调度事实源。

## 7. 必须通过的验收

| 编号 | 输入/操作 | 预期结果 |
| --- | --- | --- |
| RC01 | 重复JSON键、未知字段/ID、资源缺失、同资源双生产者 | 初始化前固定诊断失败，无模型调用 |
| RC02 | 不合法工具、越界路径、子成员继续委派、配置注入shell | 拒绝；权限只能取交集 |
| RC03 | 非法生产消费边、预算越上限/不足完成一次合法调用 | 装配失败，不伪装可运行 |
| RC04 | 同一配置键顺序变化、相同集合声明顺序变化 | 规范化后hash相同；任务顺序改变hash不同 |
| RC05 | 首Agent前冻结写入失败或暂存文件存在但未提交 | 无模型调用；同Run重试不创建第二事实 |
| RC06 | 暂停后改当前默认配置/轮换key，再关闭Store重开 | 冻结bundle可用则按原版本恢复；key轮换不改变hash |
| RC07 | 冻结方法/角色卡/资料被改，或宿主不支持旧bundle | 固定诊断停止，不读取新内容续跑 |
| RC08 | 新配置开新Run，尝试复用旧产品/方案批准 | 旧bundleHash不匹配，重新审批 |
| RC09 | 任一角色收到Store、整StateV2、未知字段或越权sourceRef | strict DTO/Port拒绝，记录脱敏诊断 |
| RC10 | 架构把需求引用填入contextRefs | 拒绝；提示词和校验器都从同一引用域派生 |
| RC11 | QA返工/故障接续/子委派 | bundle不变、预算不重置、相关版本证据失效并重验 |
| RC12 | 输出清单、报告、日志、模型prompt | 凭据哨兵与无关角色资源均不出现 |
| RC13 | 新老Run分别恢复、回退新建入口 | 各版本走各自工厂，新Run不被旧入口降级 |
| RC14 | 原生fixture完整链及同条件真实标题业务切片 | fixture证明门禁；真实行为断言、人评与准入分别报告 |

本轮只定义这些验收；历史139项不代表上述新机制已实现或通过。接入阶段执行类型检查、相关回归、完整fixture主链及隔离真实业务评测；不需要为本轮纯定义修改启动模型或部署。

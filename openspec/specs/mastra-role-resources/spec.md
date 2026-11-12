# Mastra产研角色资源

## Purpose

规定独立Mastra实践中原生Agent/Skill版本与应用Run绑定、工具装配、可信制品的职责，不改变探索主线Runtime。

## Requirements

### Requirement: 原生资源版本唯一归属
应用 SHALL 使用Mastra原生Stored Agent和Skill版本保存角色配置及完整正文/参考内容树；不得新增并行角色版本库。

#### Scenario: 发布新角色版本
- **WHEN** 用户发布通过宿主契约校验的新Agent版本
- **THEN** 后续新Run选择新版本，已冻结Run的引用不变

#### Scenario: 工作台发布受控增强
- **WHEN** 用户从工作台以当前Agent版本ID提交角色指令、模型参数或已登记工具的收紧集合
- **THEN** 宿主 SHALL 校验版本未冲突、工具仍是宿主允许集合且核心工具齐全，再创建新的Mastra原生Agent版本
- **AND** 工作台不得编辑Skill正文、工具实现、Workspace、制品信任根或任何既有Run绑定

### Requirement: 首次执行前冻结并按版本恢复
主Workflow SHALL 在首个模型调用前持久化RunID、角色Agent版本、Skill pin、工具契约摘要、模型传输身份、运行资源配置摘要、业务资料快照摘要及宿主制品摘要；恢复 SHALL 校验并使用该记录，缺失或不匹配 SHALL 拒绝，不得回退最新版本。

#### Scenario: 暂停期间切换发布版本
- **WHEN** 暂停后发布新版本并重新装配宿主
- **THEN** 原Run仍使用已记录的Agent版本及其Skill pin，审批与副作用执行前核验绑定

#### Scenario: 无冻结历史Run
- **WHEN** 请求恢复没有新资源冻结记录的Run
- **THEN** 拒绝执行，不补造快照，不执行历史兼容迁移

### Requirement: 配置与业务资料随Run冻结
运行时 SHALL 从服务端指定的严格`workflow.runtime.json`读取受限预算和角色模板声明，并在Run首步冻结其内容摘要；后续恢复 SHALL 使用冻结配置，不得让当前配置覆盖旧Run。产品角色可读的业务资料 SHALL 在同一首步复制为Run专属只读副本，恢复前逐文件核验摘要，不得回读可变来源目录。

#### Scenario: 当前配置或来源资料变化
- **WHEN** Run暂停后当前配置文件或来源资料发生变化
- **THEN** 已冻结Run继续使用冻结配置与资料副本
- **AND** 新Run才采用新的配置或来源资料

#### Scenario: Run资料副本漂移
- **WHEN** Run专属资料副本缺失、增加文件或任一文件字节摘要不匹配
- **THEN** 恢复 SHALL 以固定资源完整性错误拒绝，不能用当前来源自动补齐

### Requirement: 全角色严格交接DTO与调用证据
主Workflow SHALL 为产品四角色、开发八类模板、独立测试及运维角色使用冻结配置中登记的严格输入和输出契约。每次模型调用 SHALL 由宿主构造仅含本职责所需事实的输入投影，并在正常结束后记录输入散列、输出散列、实际工具、用量与`bundleHash`；模型文字不得自行声明这些事实。

#### Scenario: 角色接收越权运行时状态
- **WHEN** 任一产品、开发、测试或运维角色的输入含有Store、完整Workflow状态、未知字段、凭据或未登记来源
- **THEN** 宿主 SHALL 在模型调用前拒绝该输入
- **AND** 不得用整状态或当前默认配置作为静默回退

#### Scenario: 暂停恢复后进入质量和发布
- **WHEN** 已冻结Run恢复并生成测试计划或发布计划
- **THEN** 宿主 SHALL 将该角色调用证据与同一`bundleHash`写入相应产物
- **AND** 最终交付 SHALL 拒绝缺少测试或运维调用证据、或证据版本不匹配的状态

### Requirement: Run治理记录与冻结能力授权
主Workflow SHALL 将跨阶段产物统一表示为带`schemaVersion`、内容散列和证据引用的Artifact记录；Run、Artifact、Evidence、Approval、CapabilityGrant和TaskPlan的职责不得混合。项目范围确认 SHALL 由宿主生成并冻结`CapabilityGrant`，绑定Run、产品Artifact、确认摘要、角色、可写路径、登记检查、调用预算和返工预算。模型不得生成、扩张或替换授权。

#### Scenario: 经确认范围进入开发
- **WHEN** 当前产品Artifact已批准，用户确认项目范围
- **THEN** 宿主 SHALL 生成绑定该Run和产品版本的CapabilityGrant
- **AND** 后续架构任务的角色、路径和检查引用必须是该授权的子集

#### Scenario: 授权或交接物漂移
- **WHEN** CapabilityGrant的内容、Run、产品版本或散列不匹配，或Artifact缺少其声明的证据引用
- **THEN** Workflow SHALL 拒绝进入或继续受影响阶段
- **AND** 不得从当前默认配置、模型文字或历史Run补造授权

### Requirement: 统一人工关口、调用与证据投影
主Workflow及其工作台 Adapter SHALL 从已保存的原生暂停材料、角色调用、检查与外部回执派生只读`HumanGate`、`ApprovalReceipt`、`AgentInvocation`、`EvidenceRecord`与`AgentRun`投影。投影 SHALL 引用同一Run、绑定hash和既有证据；不得成为恢复输入、并行审批库或第二事实源。`AgentInvocation` SHALL 明确记录可见Artifact/Context引用、冻结CapabilityGrant引用和预算快照。

#### Scenario: 人工关口展示和提交
- **WHEN** Workflow在已登记人工关口暂停或工作台提交有效resume数据
- **THEN** 工作台 SHALL 投影绑定当前暂停材料的HumanGate
- **AND** 提交 SHALL 在既有resume schema校验后投影ApprovalReceipt，不改变原生resume语义

#### Scenario: 工具、检查和外部回执证据
- **WHEN** 角色调用返回工具结果、登记检查完成，或人工提交部署/健康/回滚回执
- **THEN** 宿主 SHALL 从已保存事实生成对应EvidenceRecord或ToolExecutionReceipt引用
- **AND** 不得把模型私有推理、凭据、任意工具输入或未脱敏输出写入该投影

#### Scenario: 外部写操作或跨实例执行
- **WHEN** 需要执行外部写操作、任务级/调用级授权、授权撤销/过期或跨实例恢复
- **THEN** 当前Run级CapabilityGrant不得被隐式扩展
- **AND** 实施前 SHALL 建立新的方案决策与OpenSpec边界

### Requirement: 工具与可信制品执行前核验
live宿主 SHALL 使用独立配置的可信公钥核验制品签名和内容清单，并核对Run绑定；工具引用、schema、实现制品及Skill blob不完整 SHALL 在调用前拒绝。工具闭包 SHALL 由当前Run/任务装配，不能从存储执行任意代码。

#### Scenario: 同名工具或依赖被替换
- **WHEN** 宿主实现/依赖字节与可信清单或Run绑定不同
- **THEN** 拒绝继续执行，不能因工具名或版本标签相同而放行

#### Scenario: 测试模式与真实模式隔离
- **WHEN** fixture使用明确标识的非签名测试制品
- **THEN** 仅允许fixture执行；live缺少独立可信签名配置必须拒绝

### Requirement: 模型与凭据边界
模型名称与生成参数 SHALL 从冻结Agent版本解析；凭据 SHALL 仅由宿主提供且不进入Run快照；模型端点身份变化 SHALL 拒绝，凭据轮换 SHALL 不改变版本绑定。业务调用 SHALL 不得用临时model覆盖冻结模型。

#### Scenario: 恢复时环境默认模型改变
- **WHEN** 默认模型改变但冻结版本和传输端点可用
- **THEN** 使用冻结模型配置；当前默认值不覆盖旧Run

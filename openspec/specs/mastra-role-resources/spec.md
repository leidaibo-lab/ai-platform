# Mastra产研角色资源

## Purpose

规定独立Mastra实践中原生Agent/Skill版本与应用Run绑定、工具装配、可信制品的职责，不改变探索主线Runtime。

## Requirements

### Requirement: 原生资源版本唯一归属
应用 SHALL 使用Mastra原生Stored Agent和Skill版本保存角色配置及完整正文/参考内容树；不得新增并行角色版本库。

#### Scenario: 发布新角色版本
- **WHEN** 用户发布通过宿主契约校验的新Agent版本
- **THEN** 后续新Run选择新版本，已冻结Run的引用不变

### Requirement: 首次执行前冻结并按版本恢复
主Workflow SHALL 在首个模型调用前持久化RunID、角色Agent版本、Skill pin、工具契约摘要、模型传输身份及宿主制品摘要；恢复 SHALL 校验并使用该记录，缺失或不匹配 SHALL 拒绝，不得回退最新版本。

#### Scenario: 暂停期间切换发布版本
- **WHEN** 暂停后发布新版本并重新装配宿主
- **THEN** 原Run仍使用已记录的Agent版本及其Skill pin，审批与副作用执行前核验绑定

#### Scenario: 无冻结历史Run
- **WHEN** 请求恢复没有新资源冻结记录的Run
- **THEN** 拒绝执行，不补造快照，不执行历史兼容迁移

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

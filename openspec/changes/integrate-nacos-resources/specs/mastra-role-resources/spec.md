## ADDED Requirements

### Requirement: Nacos is the default product resource source

新建产品 Run SHALL 默认使用 Nacos 发布的版本化 Prompt 与 Skill；服务端配置缺失或资源不可用时 SHALL 明确失败，不能静默回退到本地方法。仅显式关闭 Nacos 的兼容及隔离评测路径允许使用本地资源。

#### Scenario: New product run uses external methods

- **WHEN** 新 Run 冻结 Nacos 资源
- **THEN** 产品 Agent SHALL 使用该快照中的角色方法与 Skill
- **AND** SHALL NOT 自动注册本地产品方法套件作为新 Run 的方法来源

#### Scenario: Product reviewer uses separate methods

- **WHEN** 服务端登记审查角色的 Prompt 以及其他 Skill 的精确版本
- **THEN** 系统 SHALL 为审查角色使用已冻结的审查 Prompt，并向产品角色开放已登记的 Skill
- **AND** 资源版本与摘要 SHALL 绑定到产品审批版本

#### Scenario: Product reviewer selects a skill subset

- **WHEN** 服务端配置审查角色使用已登记的 Skill 名称子集
- **THEN** 审查角色 SHALL 只获得该子集，产品经理保持其已冻结的完整集合
- **AND** 该绑定 SHALL 与资源一起冻结并进入产品审批身份
- **AND** 未配置绑定的历史快照 SHALL 保持共享 Skill 的原有行为

### Requirement: Versioned external resources are frozen per Run

启用外部资源的新 Run SHALL 在首次使用前保存资源来源、明确版本、内容摘要和可恢复的不可变内容；恢复 SHALL 使用原冻结内容。旧 Run SHALL NOT 被补造冻结事实。

#### Scenario: Resource changes while a Run is suspended

- **WHEN** 外部资源发布新版本，而已有 Run 暂停后恢复
- **THEN** 该 Run SHALL 使用原冻结版本或在资源无法验证时停止
- **AND** 新版本 SHALL 只影响新 Run

#### Scenario: Resource access is revoked

- **WHEN** 产品角色准备使用冻结资源且原版本被下线、授权被撤销或注册中心不可访问
- **THEN** 系统 SHALL 在调用产品 Agent 前停止，而不能静默切换到本地或其他版本
- **AND** 凭据 SHALL NOT 进入冻结快照

#### Scenario: Product role revises a development blocker

- **WHEN** 带 Nacos 快照的 Run 在研发阻塞后调用产品角色整理问题或修订产品稿
- **THEN** 系统 SHALL 校验并使用原产品 Run 冻结的资源装配产品角色
- **AND** 不得静默使用启动时的本地产品角色或新版本

#### Scenario: Existing Run predates external resource integration

- **WHEN** 已保存的旧 Run 不包含 Nacos 资源快照
- **THEN** 系统 SHALL 继续使用原有本地资源，不补造外部资源快照

### Requirement: Remote methods do not grant tool authorization

外部 Prompt 和 Skill SHALL NOT 扩大宿主为产品角色注册的工具权限，或替代人工审批。

#### Scenario: A remote skill requests additional tools

- **WHEN** 已冻结的 Skill 内容要求调用未授权工具或绕过审批
- **THEN** 系统 SHALL NOT 为此增加工具或跳过审批

### Requirement: Product assets are prepared with traceable source

产品 Skill 迁移包 SHALL 保留每个 Skill 的完整入口与引用，并记录精确版本、逐文件摘要、来源锁和许可证摘要。打包过程 SHALL 拒绝符号链接及不受支持的目录，产物不得包含凭据或审批通过的虚假声明。

产品 Skill、来源锁和许可证的仓库唯一来源 SHALL 位于 `nacos-resources/product/skills/`；本地兼容路径与资源导出 SHALL 读取同一来源，保留 Skill 名称、参考资料及原始摘要。

#### Scenario: Prepare the product suite

- **WHEN** 维护者为迁移准备产品 Skill 包
- **THEN** 每个 Skill SHALL 有独立 ZIP 和可核对清单
- **AND** 角色绑定、人工审核和 Nacos 发布状态 SHALL NOT 因打包成功而被视为完成

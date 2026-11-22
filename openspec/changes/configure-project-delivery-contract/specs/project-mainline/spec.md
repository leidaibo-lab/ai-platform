## ADDED Requirements

### Requirement: Registered projects have versioned delivery contracts

系统 SHALL 允许工作台从服务端已登记项目中选择业务工程，并为项目配置仓库内需求、产品规格、开发代码、测试用例和工程规则落点。仓库地址和本地仓库身份 SHALL 只来自服务端项目注册表，不由浏览器重复提交。

#### Scenario: Configure a registered project

- **WHEN** 操作者选择一个已登记项目并保存交付契约
- **THEN** 系统 SHALL 校验所有落点均为该仓库内受支持的相对路径
- **AND** SHALL 将配置版本与项目 ID 绑定并向工作台展示仓库身份及接入状态

#### Scenario: A run starts with a delivery contract

- **WHEN** 新 Run 绑定已登记项目
- **THEN** Run SHALL 冻结项目绑定、Adapter 身份和交付契约版本摘要
- **AND** 恢复、产品交接和下游读取 SHALL 使用该 Run 冻结的配置版本
- **AND** 后续配置变更 SHALL NOT 改写既有 Run 的配置版本

### Requirement: Formal product handoff is mandatory

正式需求与产品规格 Git 交接 SHALL 是产研流程必需门禁，页面 SHALL NOT 提供关闭该交接的配置。交接失败 SHALL 保留可恢复检查点并阻止开发读取或继续。

#### Scenario: Product approval is handed off

- **WHEN** 产品稿经人工批准
- **THEN** 系统 SHALL 按 Run 冻结的落点把需求和产品规格提交到其绑定仓库
- **AND** SHALL 在 Mastra Store 保存关联远端回执后才允许下游继续

#### Scenario: The remote handoff fails

- **WHEN** 必需 Git 交接无法完成或回执校验失败
- **THEN** 系统 SHALL 暂停在可恢复交接点
- **AND** SHALL NOT 以仅有本地草稿或关闭同步设置的方式推进下游

### Requirement: New project contracts are prepared with human approval

系统 SHALL 检查项目配置所引用的契约文件和目标目录。缺失目录可按已保存配置受控创建；缺失的工程规则、Adapter 或业务规格模板可生成待确认初稿，但 SHALL NOT 自动作为已批准的项目规则、执行权限或保护检查。

#### Scenario: A registered project lacks configured contract files

- **WHEN** 操作者执行项目接入检查且发现配置契约文件缺失
- **THEN** 系统 SHALL 展示缺失项并可按项目配置生成待确认初稿
- **AND** SHALL 要求项目负责人确认后才把该版本用于后续 Run
- **AND** 未登记 Adapter、命令或权限 SHALL 保持阻断状态

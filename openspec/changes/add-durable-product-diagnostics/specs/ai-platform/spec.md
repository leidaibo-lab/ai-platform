## ADDED Requirements

### Requirement: 各角色持久化公共执行事实与专属扩展

产品、开发、测试和发布角色 SHALL 在角色节点完成后，在同一 Workflow 产物中保存版本化公共 `role-execution.v1`，至少包含阶段目标、输入引用、模型调用统计、工具调用事实、输出结构、发现、失败尝试、阻塞原因和下一步；每类角色 SHALL 同时保存对应的带 `kind` 专属扩展。

#### Scenario: 角色完成后保存公共事实和专属扩展

- **WHEN** 产品角色成功生成非空交付正文
- **THEN** 对应角色产物 SHALL 包含 `execution.version=role-execution.v1`
- **AND** 产品角色 SHALL 包含 `extension.kind=product-role-execution.v1`
- **AND** 开发角色 SHALL 包含 `extension.kind=development-role-execution.v1`
- **AND** 测试角色 SHALL 包含 `roleExtension.kind=testing-role-execution.v1`
- **AND** 发布角色 SHALL 包含 `roleExtension.kind=operations-role-execution.v1`
- **AND** 诊断 SHALL 包含正文 Hash、正文长度、模型步骤、finish reason 和下一步
- **AND** 诊断 SHALL 与角色正文在同一 Workflow 快照中提交

#### Scenario: 专属字段不污染公共基座

- **WHEN** 新增或读取角色执行记录
- **THEN** 角色差异 SHALL 保存在对应版本化扩展 Schema 中
- **AND** 公共 `role-execution.v1` SHALL 保持严格字段边界
- **AND** 系统 SHALL NOT 使用无约束 `metadata` 或把其他角色字段伪装成公共事实

#### Scenario: 工具事实脱敏保存

- **WHEN** 产品角色执行一个或多个工具调用
- **THEN** 诊断 SHALL 保存工具名称、参数指纹、是否返回、是否重复和调用次数
- **AND** 诊断 SHALL NOT 保存原始工具参数或返回正文

#### Scenario: 诊断不伪造模型私有推理

- **WHEN** 系统生成诊断投影
- **THEN** 系统 SHALL 只公开阶段目标、执行事实、输出结构和宿主验证结果
- **AND** 系统 SHALL NOT 将模型私有逐字思维链写入 Workflow 或返回前端

#### Scenario: 开发测试阶段直接升级

- **WHEN** 读取当前开发/测试阶段的产品 Run
- **THEN** 系统 SHALL 以新诊断契约作为当前实现依据
- **AND** 系统 SHALL NOT 为旧历史 Run 增加 fallback、双写或默认诊断事实

## ADDED Requirements

### Requirement: Native observability and experiment mocks are validated in isolation

平台 SHALL 提供可重复的隔离验证，核对已安装 Mastra 版本的原生 Workflow Trace 写入和敏感字段过滤，以及 Agent Experiment 对声明工具替身与未声明工具的拦截。试点 SHALL 仅使用合成数据、隔离存储和 fixture 模型，不连接远端服务或改变主线 Run 装配。

#### Scenario: Local trace is exported

- **WHEN** 隔离 fixture Workflow 完成并刷新原生观测导出
- **THEN** 隔离 Store SHALL 能读取对应 Trace，敏感字段 SHALL 按过滤规则脱敏
- **AND** 输出 SHALL NOT 被当作业务审批或恢复事实，也 SHALL NOT 证明任意自由文本已脱敏

#### Scenario: Experiment calls declared or undeclared tools

- **WHEN** 隔离 Agent Experiment 使用声明的工具替身且默认拒绝未声明工具
- **THEN** 已声明工具 SHALL 返回替身结果，未声明工具 SHALL 被拒绝，真实工具实现 SHALL NOT 执行
- **AND** 测试结果 SHALL NOT 被当作真实模型质量或工作流目标的工具拦截证明

### Requirement: Trace minimization is verified before production use

隔离试点 SHALL 以允许字段构造导出的 Span，不保留正文、工具参数及结果、错误内容、自由文本预览或未经审查的属性和元数据。只允许格式受限的 Run 标识用于关联，禁止将该策略视为其他观测信号的过滤。

#### Scenario: A fixture run contains synthetic sensitive material

- **WHEN** 平台 fixture Workflow、Agent 或工具的输入、输出和错误包含合成标记
- **THEN** 经试点策略持久化的 Trace SHALL 不包含这些标记，且可通过 Run ID 查询
- **AND** 试点 SHALL 不改变 Workflow 的运行及暂停事实

#### Scenario: A formatter fails

- **WHEN** 导出格式化失败或无法确定所有导出信号均受控
- **THEN** 系统 SHALL NOT 启用该策略于主线；必须先验证失败关闭，不能依赖框架的失败回退

### Requirement: Local minimal traces require explicit activation

主线 SHALL 默认启用本地最小化 Trace，并支持通过服务端配置显式关闭。启用后 SHALL 仅向当前 Mastra Store 写入经允许字段策略处理的 Trace，SHALL NOT 添加远端导出器或将日志、指标、评分和反馈发送到该导出器。Trace 是诊断投影，不得作为 Workflow、审批或恢复事实。

#### Scenario: An operator enables local tracing

- **WHEN** 服务端显式启用本地最小化 Trace
- **THEN** 合成和业务正文、工具参数及结果、异常详情、预览和未经允许的元数据 SHALL NOT 出现在持久化 Trace 中
- **AND** 过滤异常 SHALL 丢弃事件，不影响工作流状态或将未过滤事件交给存储
- **AND** 运行产生的 Trace 保留在配置的本地 Store，关闭开关不删除已有数据

#### Scenario: The tracing setting is absent or invalid

- **WHEN** 本地 Trace 配置缺省或为 true
- **THEN** 应用 SHALL 装配本地最小化观测导出器
- **WHEN** 本地 Trace 配置为 false
- **THEN** 应用 SHALL 不装配本变更的观测导出器
- **WHEN** 配置值不为 true 或 false
- **THEN** 配置解析 SHALL 拒绝启动，不静默改变采集行为

#### Scenario: A product phase assembles a temporary agent

- **WHEN** 产品写作或独立审查为当前 Run 装配临时 Agent
- **THEN** 调用 SHALL 传递宿主 Mastra 实例和当前原生追踪上下文，使 Agent 与工具 Span 可关联原 Workflow Trace
- **AND** 本地导出 SHALL 保持正文、工具输入输出和错误详情最小化，不改变审批或恢复状态

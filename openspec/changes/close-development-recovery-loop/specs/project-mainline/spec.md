## ADDED Requirements

### Requirement: Development routes failures by evidence and responsibility

研发 Workflow SHALL 在上下文核实、方案生成、就绪审查、实施、自检和独立评审中，依据结构化证据及已批准契约确定处理路径。项目适配 SHALL 提供已登记的授权和验收依据。

#### Scenario: An approved business rule is implemented incorrectly

- **WHEN** 固定检查、验收用例或独立评审能引用已批准规则并证明候选实现与其不符
- **THEN** 研发团队 SHALL 在授权内修复偏差，并以对应验收用例及受影响的固定检查复验
- **AND** 已批准规则、验收期望与保护检查 SHALL 作为复验的固定依据

#### Scenario: A business rule is missing, contradictory or requires a decision

- **WHEN** 现有批准材料无法确定正确行为，或修复需要改变范围、规则、验收期望
- **THEN** Workflow SHALL 通过产品澄清提供冲突引用、受影响场景和需要决定的问题
- **AND** 受影响范围 SHALL 等待批准版本，后续计划、检查与审批 SHALL 绑定该版本并重新验证

#### Scenario: A technical failure has a known cause

- **WHEN** 有证据表明故障来自短暂传输异常、输出格式、工具依赖、环境配置或代码实现
- **THEN** Workflow SHALL 按已登记策略执行退避、针对性重新生成、受控修复或交由依赖负责人处理
- **AND** 继续执行 SHALL 使用经核验的检查点及与该故障匹配的反馈

#### Scenario: A failure cannot yet be diagnosed or safely recovered

- **WHEN** 原因仍未知、检查点无法核验、权限不足或副作用状态无法确定
- **THEN** Workflow SHALL 保存可取得的证据，按能力执行受控诊断或回查，并将剩余阻塞交给相应负责人
- **AND** 需要授权时 SHALL 展示明确的决策事项和影响范围

### Requirement: Recovery actions and validation results are traceable

Mastra Workflow 状态 SHALL 关联故障、处理动作及验证结果。关联 SHALL 包含运行、阶段、角色、任务、检查点和稳定故障标识。脱敏证据 SHALL 记录已知的故障分类、诊断来源和可定位的校验或检查引用。

#### Scenario: A recovery action is verified

- **WHEN** 研发或平台执行处理动作
- **THEN** Workflow SHALL 保存引用的故障、执行角色、实际动作及适用的策略版本
- **AND** 验证结果 SHALL 关联实际执行的检查、结论及受验证的方案或源码版本
- **AND** 原故障排除 SHALL 以针对其原因的验证通过为依据。仅观察到接续成功时 SHALL 记录执行通过及原故障未定位

#### Scenario: A technical check passes but business readiness remains open

- **WHEN** 技术方案重新生成并通过结构与约束校验
- **THEN** Workflow SHALL 记录通过校验的 `planHash` 并继续独立就绪审查
- **AND** 方案实施 SHALL 经过既有审批。未解决业务发现 SHALL 按产品澄清规则推进

### Requirement: Development continuation is bounded and resumable

Workflow SHALL 为 Run 绑定可配置的故障接续上限及策略版本，并同时执行既有模型角色调用、验证、返工和超时预算。故障接续 SHALL 从已保存检查点开始并复用有效的上下文与已完成任务。

#### Scenario: A recovery attempt consumes the continuation budget

- **WHEN** 故障后的下一次阶段执行实际启动
- **THEN** Workflow SHALL 以该接续的稳定标识扣减一次 Run 的接续额度，包括短暂故障退避后的再执行
- **AND** 首次执行、查看诊断、等待依赖恢复及同一接续的重复提交 SHALL 保持接续计数

#### Scenario: The workflow continues automatically

- **WHEN** 故障存在适用的恢复动作或短暂异常重试策略，且授权、版本和预算仍有效
- **THEN** Workflow SHALL 自动执行获准接续并记录次数，工作台 SHALL 展示状态及验证进度
- **AND** 同一请求的重复投递 SHALL 复用已保存的接续结果。同一接续因进程中断恢复 SHALL 核对执行及副作用状态后继续

#### Scenario: Recovery is exhausted or no progress is observed

- **WHEN** 达到配置上限、触及既有预算边界，或重复复验未产生进展
- **THEN** Workflow SHALL 停止对应的自动处理路径，保存最后可核验的候选、失败与验证证据
- **AND** 工作台 SHALL 展示停止原因、责任方及可以执行的决定。预算追加 SHALL 由有权人员批准

#### Scenario: An authorized platform integration confirms dependency repair

- **WHEN** 已启用平台恢复通知，且已分类的平台依赖故障有接续额度并可核验候选
- **THEN** Workflow SHALL 在原生暂停点等待平台恢复事件，事件 SHALL 绑定 Run、故障和暂停版本并由服务端验证来源
- **AND** 工作台 SHALL 展示等待平台恢复，业务用户无需确认重试
- **AND** 事件 SHALL 触发一次带实际复验的接续。平台通知仅提供依赖已处理的证据，原阶段的检查结果决定是否通过

#### Scenario: A repair event is delivered more than once

- **WHEN** 已处理的事件或同一暂停版本的重复通知到达任一实例
- **THEN** 服务 SHALL 通过 Mastra 原生状态与恢复所有权回读结果，重复通知无需重新执行，只有写入原生回执的请求 SHALL 返回首次受理
- **AND** 过期暂停、来源认证失败、检查点漂移以及已耗尽的预算 SHALL 拒绝接续
- **AND** 原阶段有外部写入时 SHALL 通过该适配器的幂等操作与现状回查核对结果。提交状态未知时 SHALL 保留待处理证据

### Requirement: The workbench exposes actionable recovery status

工作台 SHALL 从 Mastra 保存状态展示故障事实、处理归属、最近动作和复验结果。诊断详情 SHALL 使用脱敏结构化数据，技术计数 SHALL 与业务待办分别呈现。

#### Scenario: Recovery requires no business input

- **WHEN** 研发或平台正在处理技术故障，或技术故障已经转交对应责任方
- **THEN** 工作台 SHALL 展示处理状态和后续结果，业务用户 SHALL 能查看进展与证据摘要，故障接续由研发或平台的处理结果触发

#### Scenario: A decision is required

- **WHEN** 流程需要产品澄清、方案审批、权限授权或额外预算
- **THEN** 工作台 SHALL 展示需要决定的内容、依据与影响，并使用对应关口记录决定

#### Scenario: Reading a historical run

- **WHEN** 历史 Run 缺少新增的动作或复验关联
- **THEN** 工作台 SHALL 展示已有证据并标明未记录的内容，Workflow SHALL 按原版本读取和恢复

#### Scenario: Comparing human intervention across runs

- **WHEN** 试运行读取一组 Run 的恢复证据
- **THEN** 服务 SHALL 提供技术故障数、自动接续结果、平台恢复数、已提交人工技术恢复次数和业务澄清及方案审批次数
- **AND** 历史 Run 缺少观测记录时 SHALL 明确报告观测范围，降幅 SHALL 使用实际可比样本计算

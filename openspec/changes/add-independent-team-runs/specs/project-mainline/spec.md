## ADDED Requirements

### Requirement: Independent team runs use normalized trusted inputs

产品、研发、测试和交付团队 SHALL 提供独立启动入口，并使用版本化规范入参。统一入参 SHALL 标识团队、项目、迭代、来源类型、来源 Run/产物引用、预算和团队专属载荷；服务端 SHALL 校验团队与来源类型的兼容性，并在 Mastra Store 中冻结规范化输入及其来源散列。

从已有 Run 接入时，客户端 SHALL 只提交来源 Run ID 和经允许的产物标识；服务端 SHALL 从原生 Store 与登记 Git 回执重读内容、批准状态和版本。预先提供材料时，接入入口 SHALL 按团队契约校验格式、项目身份和必要证据，并要求适用的人工确认。客户端 SHALL NOT 伪造批准、测试通过、候选散列、仓库路径、Git revision、Adapter 或执行命令。

#### Scenario: Product team starts independently

- **WHEN** 用户为已登记项目提交原始需求启动产品团队
- **THEN** 产品团队 SHALL 执行既有澄清、写作、独立审查与人工批准关口
- **AND** Run SHALL 保存规范化输入及项目绑定，且 SHALL NOT 自动启动研发团队

#### Scenario: Development consumes an approved product source

- **WHEN** 用户选择同项目中已有的已批准产品 Run，或提交已校验且经确认的产品输入包
- **THEN** 服务端 SHALL 重读并绑定已批准产品正文、证据、项目 revision、Adapter profile 与授权范围
- **AND** 研发团队 SHALL 保留项目范围确认和方案审批，且 SHALL NOT 接受客户端提供的批准状态或源码候选

#### Scenario: Testing consumes a development delivery

- **WHEN** 用户选择同项目中已交付的研发 Run 或提交已校验候选输入包
- **THEN** 服务端 SHALL 重读候选检查点、产品与开发规格、登记检查身份和来源证据
- **AND** 测试团队 SHALL 重新生成并审批测试计划，独立执行登记检查及质量确认
- **AND** 测试 Run 的缺陷返工 SHALL 通过版本化研发 Port 请求，不得直接改写来源 Run

#### Scenario: Delivery consumes a passed QA result

- **WHEN** 用户选择同项目中已通过质量门的测试 Run
- **THEN** 服务端 SHALL 重读同一候选版本、QA 报告及正式规格回执并核对来源关系
- **AND** 缺少或不匹配任一证据时 SHALL 拒绝远端交付
- **AND** 交付只创建并记录 MR，不得合并、部署或接受手工声明的测试通过

#### Scenario: Team input identity changes during recovery

- **WHEN** 独立团队 Run 恢复时其冻结来源、项目 revision、Adapter 或输入散列发生漂移
- **THEN** 系统 SHALL 拒绝执行，并保留原生 Store 中已保存的输入和恢复事实

#### Scenario: Product rework preserves the trusted boundary

- **WHEN** 用户在独立产品团队的当前产品审批关口退回产品稿
- **THEN** 服务端 SHALL 校验当前产物版本并派生返工输入，通过原生 timeTravel 重做
- **AND** 原生入口 SHALL 只接受当前服务端调用授权的 Run、目标步骤与输入散列，拒绝直接提交伪造返工输入

#### Scenario: Independent team resumes after platform dependency repair

- **WHEN** 独立团队在平台依赖暂停点收到经过身份校验的修复通知
- **THEN** 平台 SHALL 在该团队实际 Workflow 身份下原子认领原生快照并恢复
- **AND** 来源、输入包、项目和候选版本 SHALL 在执行前再次核验，重复事件 SHALL 只回读已保存回执

#### Scenario: Independent candidate and specification ownership

- **WHEN** 测试或交付团队从已完成的来源 Run 启动
- **THEN** 服务端 SHALL 校验来源检查点并复制候选到新 Run 的独占执行目录
- **AND** 固定检查和审批事实 SHALL 绑定原候选散列，测试返工只修改新 Run 的候选
- **AND** 正式规格 SHALL 在新 Run 分支按原回执重读后重新登记，上游关系 SHALL 随新回执重新绑定
- **AND** 初始化中断后重试 SHALL 校验已存在副本并拒绝覆盖漂移内容
- **AND** 测试和交付 SHALL 保存来源研发批准所绑定的原输入，批准散列 SHALL 继续绑定该输入和原方案
- **AND** 仅候选所有者、项目关联和重新登记的 Git 回执可重绑定，业务正文、方法、预算和工程范围改变时 SHALL 拒绝继承批准

### Requirement: Team regression suites are independently executable

产品、研发、测试和交付 SHALL 各自拥有可独立执行的团队级回归套件，覆盖专业规则、权限边界、输入输出契约、暂停/停止与版本绑定。全链路回归 SHALL 继续覆盖团队间交接、返工和端到端终态；团队级回归通过不得替代全链路或真实远端交付证据。

#### Scenario: Independent team regression records its environment

- **WHEN** 团队独立回归运行完成
- **THEN** 报告 SHALL 记录实际 Workflow、来源版本、执行环境与结果
- **AND** fixture、真实模型、真实远端 MR 和生产验收 SHALL 分别记录

### Requirement: Registered input packages use native approval facts

输入包 SHALL 由服务端把原始产品需求或已核验的团队来源引用规范化后登记为 Mastra Workflow Run。确认 SHALL 记录工作台身份与当前版本；撤销 SHALL 使用同一 Workflow 的原生暂停关口。客户端 SHALL 只使用输入包 Run ID 和散列启动团队，不得借输入包注入批准、QA 或候选正文。输入包被撤销、模式或项目绑定变化、来源漂移时 SHALL 拒绝新启动与恢复。

#### Scenario: Confirm and revoke a registered input package

- **WHEN** 用户登记输入包、明确确认后启动适用团队，再撤销该输入包
- **THEN** Store SHALL 保存准备、确认和撤销的原生步骤事实
- **AND** 团队启动 SHALL 只消费服务器重读的规范输入
- **AND** 撤销后的新启动与已有团队恢复 SHALL 在执行前拒绝

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

### Requirement: Team regression suites are independently executable

产品、研发、测试和交付 SHALL 各自拥有可独立执行的团队级回归套件，覆盖专业规则、权限边界、输入输出契约、暂停/停止与版本绑定。全链路回归 SHALL 继续覆盖团队间交接、返工和端到端终态；团队级回归通过不得替代全链路或真实远端交付证据。

### Requirement: Pluggable teams expose validated results and isolated execution

平台 SHALL 通过版本化团队注册描述声明四个团队的 Workflow、输入来源和输出类型。独立入口 SHALL 复用团队专业 Workflow；主流程的历史图和输入保持兼容。`team-run-output.v1` SHALL 包含规范输入散列、来源散列、当前 Run 关联、公共团队状态与经团队 Schema 校验的专业结果；完成必须由专业质量门决定。

独立测试和交付 SHALL 从服务端来源候选复制经散列复核的源码到当前 Run 独占目录，保留上游研发输入、批准与累计预算，不修改来源 Run。当前执行关联和正式规格副本 SHALL 与上游批准输入分开保存，不得伪造新的研发批准。恢复 SHALL 在原生入口修改状态前重验冻结项目、来源和输入；禁止重初始化或注入替代上下文。

预先提供的产品材料 SHALL 经独立的原生输入接入 Workflow 保存并人工确认；产品输入包只提供需求，研发产品输入包必须经过产品版本批准。测试输入包 SHALL 引用可验证的研发来源，不能上传自称通过的研发或 QA 状态。交付 SHALL 仅接受权威 QA 来源。

#### Scenario: Teams exchange canonical results

- **WHEN** 一个团队独立完成本职工作
- **THEN** 系统 SHALL 输出带团队标识、状态、版本和证据的规范结果
- **AND** 后继团队 SHALL 按来源类型从 Store 重读结果，拒绝错团队、跨项目、漂移或未完成的来源

#### Scenario: Source workflow matches its artifact

- **WHEN** 下游请求指定已有来源 Workflow 和产物类型
- **THEN** 服务端 SHALL 只接受主流程，或与该产物对应的独立上游团队 Workflow
- **AND** SHALL 使用所指定的 Workflow ID 从 Store 读取，不得静默回退到主流程

#### Scenario: Independent QA repairs its own candidate

- **WHEN** 独立测试要求研发返工
- **THEN** 研发返工 Port SHALL 仅操作本轮独占候选并沿用累计预算
- **AND** 来源 Run 的快照、候选和批准 SHALL 保持原版本

#### Scenario: Input package requires explicit confirmation

- **WHEN** 用户提交预先准备的材料
- **THEN** 接入 Workflow SHALL 校验团队、项目和材料结构并停在人工确认
- **AND** 未确认包、旧版本确认或手工 QA 通过声明 SHALL 被拒绝

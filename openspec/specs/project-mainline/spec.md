# project-mainline Specification

## Purpose

该规范定义 ai-platform v2 的根目录主线：以完整 Mastra 应用承载需求澄清、产品确认、
开发、测试、发布和 Run 工作台；原自研 Runtime 作为独立探索实践保留。

## Requirements

### Requirement: Root defaults to the complete Mastra application

仓库根目录 SHALL 以完整 Mastra 应用作为默认开发、测试、构建和工作台入口，并保留远端
`origin/main` 基线中的需求入口、Run 状态、时间线、人工关口和 Workflow 能力。

#### Scenario: Maintainer uses root application commands

- **WHEN** 维护者在仓库根目录执行主应用脚本
- **THEN** 脚本 SHALL 使用根目录的 Mastra 依赖、`src/`、`web/` 和 `config/`
- **AND** SHALL NOT 依赖 `practices/mastra/` 作为运行源码目录

### Requirement: Custom exploration remains isolated

原自研 Runtime、Demo、LiteLLM、场景和实验 SHALL 位于
`practices/custom-exploration/`，并独立持有其依赖、配置、环境样例和稳定契约。

#### Scenario: Mainline runs without the custom Runtime

- **WHEN** 根 Mastra 应用启动或执行测试
- **THEN** 主线源码 SHALL NOT 导入探索 Runtime、GatewayClient 或探索 SQLite Store
- **AND** 主线数据目录 SHALL NOT 成为探索实践的数据目录

### Requirement: Mastra Store remains the execution fact owner

Workflow 执行、审批和恢复事实 SHALL 由 Mastra Store 持有。时间线、SSE 活动流、文件和工具
摘要 SHALL 是安全的只读投影，不能成为第二事实源。

#### Scenario: Workbench reads execution activity

- **WHEN** 工作台展示 Run 时间线或接收活动通知
- **THEN** 页面 SHALL 从原生 Workflow 快照和受控事件读取公开元数据
- **AND** SHALL NOT 接收模型隐藏推理、密钥、工具结果正文或任意文件内容

### Requirement: All model-backed team roles provide safe live output

产品、研发、测试和发布团队中实际调用模型的角色 SHALL 通过同一 Workflow watch 与工作台 SSE
链路提供增量文本及工具生命周期投影。投影 SHALL 是易失的只读展示信息，不能改变或替代
Mastra Store 中的执行、审批、恢复或交付事实。

#### Scenario: A model-backed role produces streaming output

- **WHEN** 产品、研发上下文、架构、就绪审查、实现、代码审查、测试或发布角色在 live 模式生成内容
- **THEN** 工作台 SHALL 接收带角色和尝试次数的文本增量及工具开始、完成或失败状态
- **AND** SHALL 使用与产品角色相同的受控 SSE 端点及断线快照回读机制
- **AND** 并行实现成员 SHALL 以其实际授权角色分别投影，不能共享或伪造其他成员的输出

#### Scenario: A stream event contains sensitive or unsupported data

- **WHEN** 模型流包含隐藏推理、工具参数、工具结果正文、密钥、文件内容或未登记角色
- **THEN** 系统 SHALL NOT 将该数据投影到浏览器
- **AND** 确定性 self-check SHALL 仅以既有 Workflow 活动和检查证据呈现，不得伪造模型正文流

### Requirement: Development preparation respects repository facts

研发团队 SHALL 基于仓库事实识别已有技术栈和工程准备缺口，不能将固定执行档的文件清单当作所有仓库的既有事实。

#### Scenario: Repository stack is unknown or incompatible

- **WHEN** 仓库未提供足够证据或显示其他技术栈
- **THEN** 系统 SHALL 区分未识别与执行档不匹配，保留证据，不得自动生成指定技术栈文件
- **AND** 受限或无法读取的文件 SHALL NOT 被报告为确认缺失
- **AND** 未完成独立验证时 SHALL NOT 批准实施

#### Scenario: Project confirmation uses standard execution budgets

- **WHEN** 用户在工作台确认开发项目和代码版本
- **THEN** 工作台 SHALL 直接绑定 `autonomy.v1` 的标准预算（3 轮返工、72 次累计开发模型调用、24 次登记检查、连续 2 次无进展），项目确认页省略预算表单
- **AND** 实施方案批准包 SHALL 保留执行预算供审阅

### Requirement: Late business gaps return through product clarification

测试或发布阶段发现属于业务规则、验收口径或产品责任的未闭环项时，系统 SHALL 保留该阶段已
产生的证据并回流至受控产品澄清；不得将该类问题伪装为纯代码返工，也不得只将 Run 停在开发
入口而不给出澄清路径。

#### Scenario: QA identifies a business gap after development delivery

- **WHEN** 测试质量确认以 `business` 类发现或 `product` 路由退回当前研发交付
- **THEN** 系统 SHALL 保留该轮测试计划、执行结果与质量审阅，并将发现绑定为产品澄清问题
- **AND** SHALL 使旧研发交付、测试通过和发布授权失效
- **AND** 在修订产品稿获得人工确认后，SHALL 沿用原 Run 的受限代码权限和累计预算重新规划、实施、测试及发布

#### Scenario: Release health identifies a business gap

- **WHEN** 已完成外部发布回执后的健康确认报告提供 `business` 类或 `product` 路由发现
- **THEN** 系统 SHALL 先保留发布与健康回执，并在需要时完成既有回滚关口
- **AND** SHALL 将业务发现送入与测试相同的产品澄清和修订确认链
- **AND** SHALL NOT 将健康失败自动解释为可由代码重试解决的问题

### Requirement: Confirmed specifications are committed to one remote Run branch

需求文档、产品 Spec、开发 Spec 和测试 Spec SHALL 仅在相应人工确认成功后由系统提交并推送到
同一远端 Run 分支。该分支 SHALL 使用 `run/<主要能力>-<runId>` 命名，主要能力来自受控的
Run 标识而非客户端提交的任意 Git ref；同一 Run 不得创建阶段性分支或向主分支写入。

#### Scenario: First confirmed requirement creates the Run branch

- **WHEN** 产品负责人确认本 Run 的需求文档
- **THEN** 系统 SHALL 创建或续接对应的远端 Run 分支，并提交已确认的需求文档与产品 Spec
- **AND** SHALL 保存分支名、提交 SHA、各文件散列和 push 成功回执为 Workflow 事实
- **AND** 远端拒绝、分支非快进或 push 校验失败时 SHALL 停在当前确认阶段，不得将本地文件当作已交接版本

#### Scenario: Downstream specification consumes confirmed upstream files

- **WHEN** 开发或测试角色生成其 Spec
- **THEN** 系统 SHALL 读取同一 Run 分支中已推送且散列匹配的上游文件
- **AND** 开发 Spec SHALL 绑定需求文档和产品 Spec 的提交版本
- **AND** 测试 Spec SHALL 额外绑定开发 Spec 的提交版本

#### Scenario: Business clarification changes an upstream requirement

- **WHEN** 业务澄清形成新的已确认需求版本
- **THEN** 系统 SHALL 在同一 Run 分支追加提交，不得改写既有 Git 历史
- **AND** SHALL 使依赖旧提交的产品、开发和测试 Spec 失效
- **AND** SHALL 要求重新确认并推送受影响的下游 Spec 后才允许继续实施、测试或发布

### Requirement: A successor Run imports only verified formal specification baselines

已结束 Run 的后继 Run SHALL 仅从来源 Run 已确认并已推送的正式规格中导入经散列校验的只读基线。
后继 Run SHALL 使用新的 Run 标识和新的 `run/<主要能力>-<runId>` 分支，且不得继承来源 Run 的人工审批、调用预算、测试结果、发布授权或外部回执。

#### Scenario: Create a successor from a blocked Run

- **WHEN** 用户选择来源 Run 中一个或多个已确认的产品、开发或测试 Spec 并提交新的变更说明
- **THEN** 服务端 SHALL 从 Mastra Store 的规格回执解析固定 branch、commit、path 与 hash，并从受控仓库读取并重算内容散列
- **AND** 系统 SHALL 将来源 Run、已校验的制品版本及变更说明保存为新 Run 的 Workflow 事实
- **AND** 新 Run SHALL 从产品澄清及人工确认开始，而不是恢复或复制来源 Run 的执行状态

#### Scenario: Source specification is missing or has drifted

- **WHEN** 来源 Run 没有对应的已确认回执、Git 固定版本不可读取或文件散列不匹配
- **THEN** 系统 SHALL 拒绝创建后继 Run
- **AND** SHALL NOT 接受浏览器提供的 Git branch、commit、仓库路径、文件正文或审批数据作为替代

### Requirement: Product review can re-enter same-Run clarification before confirmation

产品负责人对未确认产品稿请求返工时，系统 SHALL 在同一 Run 中保存来源稿、散列、审阅意见和返工轮次，并回到需求澄清；不得推送该未确认版本、进入开发或复用旧审批。

#### Scenario: Product reviewer requests clarification and rework

- **WHEN** 人工产品确认以 `rework` 决定提交当前稿的审阅意见
- **THEN** 系统 SHALL 使当前待审产品稿失效，并从该 Run 的需求澄清节点重新开始
- **AND** 产品经理 SHALL 获得受控的来源稿与反馈上下文，重新形成产品稿后等待新的人工确认

### Requirement: Approved requirements link to versioned acceptance evidence

新建 live 产研 Run 的产品稿 SHALL 声明带唯一 `REQ-` ID 的可独立验收条目，条目正文 SHALL 包含可观察的验收预期。产品审批绑定整份正文与其中的 ID。研发任务及测试用例 SHALL 引用当前批准 ID，且各自覆盖全部条目。系统 SHALL 提供可按需求查看的任务、用例、结果、证据来源和版本。历史无 ID 的 Run SHALL 保留已保存的原文锚点与审批绑定。

#### Scenario: Approved requirements reach independent QA

- **WHEN** 产品稿确认后进入研发和独立测试
- **THEN** 系统 SHALL 使用稿件内的 ID 进行结构覆盖检查，拒绝重复、未知及遗漏的引用
- **AND** 验收结果 SHALL 绑定当前产品、方案及候选版本，并保留各用例的实际证据来源

#### Scenario: Product revision affects existing acceptance cases

- **WHEN** 已批准产品稿进入修订审阅
- **THEN** 系统 SHALL 按 ID 与条目正文比较新旧稿，区分新增、修改和移除，列出受影响的历史用例及需要重建或补齐的覆盖
- **AND** 新版 SHALL 重新确认并执行现有全量质量门，历史通过结果只作为历史证据
- **AND** 对无稳定 ID 的历史材料 SHALL 明确采用保守全量回归

# project-mainline Specification

## ADDED Requirements

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

#### Scenario: Compact progress highlights the current step

- **WHEN** 工作台的流程进度面板能够从当前 Run 定位到具体执行节点
- **THEN** 面板 SHALL 在对应节点标题旁显示当前节点图标和无障碍标识
- **AND** 用户 SHALL 能通过团队标题直接展开或收起节点列表，浮层保持打开

### Requirement: Model failure diagnostics state only their recorded scope

工作台和恢复关口 SHALL 依据已保存的白名单诊断展示单次模型调用的失败来源，不得将上游 HTTP 响应错误表述为用户本地网络故障、模型服务整体不可用或模型配置无效。

#### Scenario: Upstream gateway returns a 5xx response

- **WHEN** 已保存诊断的失败来源为 `upstream-http` 且包含 HTTP 5xx 状态码
- **THEN** 页面 SHALL 展示“上游模型网关返回 HTTP <状态码>”
- **AND** 对 408、504 或 524 SHALL 额外说明该请求超时
- **AND** SHALL 保留检查点和重试入口，不暴露上游地址、请求正文、响应正文、认证信息或模型隐藏推理

#### Scenario: Recovery displays a recorded output-validation failure

- **WHEN** 研发阶段因输出校验失败而暂停，且原生快照保留了脱敏校验诊断
- **THEN** 恢复关口 SHALL 展示校验原因，模型调用诊断中的 `unknown` 不得覆盖该原因
- **AND** 恢复关口 SHALL 依据当前执行模式说明输出校验失败是否参与自动重试

### Requirement: Late business gaps re-enter controlled clarification

测试或发布阶段发现业务未闭环时，主 Workflow SHALL 保留阶段证据、进入产品澄清和修订确认，
并且只在新产品版本确认后重新规划及回归。

#### Scenario: QA returns a business finding

- **WHEN** QA 质量审阅提交 `business` 类或 `product` 路由发现
- **THEN** 系统 SHALL 保留 QA 历史而不是进入普通开发返工
- **AND** SHALL 将发现转为必须回答的产品澄清项
- **AND** 修订产品确认后 SHALL 使旧研发、QA 与发布版本失效并重新执行后续阶段

#### Scenario: Release health returns a business finding

- **WHEN** 发布后健康报告带有 `business` 类或 `product` 路由发现
- **THEN** 系统 SHALL 保留发布和健康证据，并先完成所需回滚关口
- **AND** SHALL 按与 QA 相同的澄清、确认、重新规划和回归路径继续

### Requirement: Platform-created delivery branches start from remote main

平台首次发布正式 Run 分支或归档分支时，SHALL 从目标仓库的 `origin` 获取 `refs/heads/main`，以获取的分支头作为首笔交付提交的父提交。

#### Scenario: A delivery branch is absent on origin

- **WHEN** 正式规格或归档准备发布到尚不存在的远端分支
- **THEN** 系统 SHALL 拉取目标远端的 `main`，并基于其分支头创建交付分支
- **AND** `main` 缺失、拉取失败或正式规格绑定的工程版本与获取的 `main` 分支头不一致时，系统 SHALL 停止此次发布
- **AND** 未推送的提交仅在其父提交仍匹配本次获取的 `main` 分支头时复用

#### Scenario: A delivery branch already exists on origin

- **WHEN** 对应远端分支已经存在
- **THEN** 系统 SHALL 追加到该分支当前版本，已发布的相同交付 SHALL 复用原回执

### Requirement: Formal specifications use one capability-named Run branch

已确认的需求文档、产品 Spec、开发 Spec 与测试 Spec SHALL 由系统在同一个远端 Run 分支
追加提交和推送。分支名 SHALL 是 `run/<主要能力>-<runId>`，不允许客户端提供 Git ref、目标
分支或推送地址。每个需求 Run 使用独立分支，同一迭代下的不同 Run 也不得复用分支或以其他 Run 分支为创建基线。

#### Scenario: A confirmed stage publishes a formal specification

- **WHEN** 对应阶段的人工确认通过
- **THEN** 系统 SHALL 使用独立 index 创建仅包含该阶段制品的不可变提交并校验远端分支
- **AND** SHALL 将分支、commit、文件散列和上游提交绑定保存到 Workflow 状态
- **AND** SHALL NOT 向默认分支或新的阶段分支推送

### Requirement: Successor Runs preserve specification provenance without inheriting authority

已结束 Run 可创建新的后继 Run。后继 Run SHALL 从来源 Run 的已确认、已推送规格回执读取并校验固定 Git 内容，保存来源溯源，但不得复用来源 Run 的审批、预算、质量、发布或恢复事实。

#### Scenario: A blocked Run starts a successor

- **WHEN** 用户提交新的 Run 标识、变更说明及来源已确认规格的种类
- **THEN** 服务端 SHALL 校验来源回执和散列并以新的 Run 标识启动产品澄清
- **AND** 新 Run SHALL 使用自己的能力命名 Run 分支提交后续确认的规格

### Requirement: Product Harness routes same-Run corrections and rework

产品团队 Harness SHALL 对生成中的立即纠偏及待审产品稿的返工使用同一套版本化影响判断。团队 SHALL 从可重跑的产品节点中选择覆盖影响的最早节点，保留上游有效结论。判断不明或现有业务决定需要重新确认时 SHALL 回到需求澄清。修订稿 SHALL 经过独立产品检查和新的人工确认。
真实模型的每次返工分类调用 SHALL 使用独立的 Mastra Memory 线程。

#### Scenario: A downstream business gap returns to Product Harness

- **WHEN** 研发或质量确认将当前已批准产品版本中的业务缺口送入产品团队
- **THEN** 产品团队 SHALL 使用与立即纠偏及待审稿退回相同的版本化返工判断，绑定已批准版本、保存的缺口证据及已有需求或用例引用
- **AND** 已明确标记的业务缺口 SHALL 进入同 Run 的人工澄清关口，保持其为必答事项，保留未受影响的已批准结论
- **AND** 修订稿 SHALL 获得新的人工批准，随后沿用既有授权和累计额度重新规划、实施并验证，旧 QA 放行不得用于修订版本
- **AND** 已暂停的历史关口 SHALL 按原版本校验恢复

#### Scenario: Product reviewer requests rework

- **WHEN** 人工以 `rework` 提交当前待审版本和意见
- **THEN** 系统 SHALL 保存来源稿、版本和意见，并在同一个 Run 按影响重做产品工作
- **AND** 旧稿 SHALL 失去审批资格，且 SHALL NOT 进入研发或正式同步

#### Scenario: User corrects product generation in progress

- **WHEN** 已登录用户从工作台底部输入框提交与当前产品生成尝试匹配的立即纠偏
- **THEN** 系统 SHALL 请求停止该尝试，在 Mastra 原生暂停检查点保存反馈，再按团队判断启动重做
- **AND** 工作台 SHALL 区分停止中、已保存待重新执行、已随目标节点开始应用以及失败后的继续入口
- **AND** 工作台 SHALL 始终使用通用输入框和发送动作，由当前节点决定如何处理输入。输入框及其周围 SHALL NOT 显示节点用途说明。可纠偏时，即使生成请求仍在等待，当前节点也 SHALL 接收纠偏。纠偏草稿遇到尝试结束或更换 SHALL 保留，且 SHALL NOT 自动改送到其他尝试或人工关口
- **AND** 已结束或已更换的生成尝试 SHALL 拒绝旧提交并保留页面输入
- **AND** 同一反馈 SHALL NOT 被重复执行，旧尝试结果 SHALL NOT 成为新交接物

#### Scenario: Workbench user opens the account menu

- **WHEN** 用户悬停在工作台左侧栏底部的账号入口，或通过点击、键盘展开入口
- **THEN** 工作台 SHALL 显示包含账号操作和远端同步设置的悬浮菜单

#### Scenario: Local account session authenticates correction requests

- **WHEN** 本机工作台首次设置账号，或已有账号登录
- **THEN** 服务端 SHALL 按当前数据目录保存本机账号的密码派生值，并签发有时限的 HttpOnly 会话
- **AND** 纠偏与继续纠偏 SHALL 要求有效会话，提交人 SHALL 由会话账号取得，请求正文 SHALL NOT 指定提交人
- **AND** 退出 SHALL 立即撤销当前会话。账号用于纠偏身份记录，其他人工关口仍按原规则处理

### Requirement: Confirmed requirements and product tasks become one versioned handoff

新建 live Run 的待审产品稿 SHALL 同时包含独立的需求文档与产品规格。需求文档 SHALL 给出目标、范围、带稳定 `REQ-` ID 的业务规则与可观察验收场景。产品规格 SHALL 按可独立复核的业务结果拆分任务，写明可观察的交付结果并引用需求文档中的 ID。系统 SHALL 校验任务 ID 唯一、引用有效且全部需求均有任务覆盖。

#### Scenario: Product owner confirms the two documents

- **WHEN** 产品负责人批准当前待审正文，或批准业务阻塞澄清后的修订正文
- **THEN** 系统 SHALL 在同一正式 Run 分支提交 `product/<迭代标识>/requirements.md` 与 `product/<迭代标识>/product-spec.md`，两份文件内容分别取自批准正文
- **AND** 用户最初提交的描述 SHALL 留在 Run 的原始需求中
- **AND** 研发开工前 SHALL 按回执读取两份文件，核对分支、散列及其与同一批准正文的一致性，再将批准正文及其需求 ID 交给研发与测试

#### Scenario: Product team opens the published handoff

- **WHEN** 当前批准版本的正式规格已发布
- **THEN** 工作台 SHALL 在同一区域展示审批人、审批版本与两份固定提交的文件入口
- **AND** AI 方向初稿 SHALL 只在方向对齐阶段作为当前内容呈现，阶段产物仍归原生 Run

### Requirement: Mainline delivery ends at a verified merge request

默认产研 Workflow SHALL 在独立 QA 通过后进入交付团队。交付 SHALL 核对候选源码散列、QA 证据及正式规格，向登记仓库的 `main` 创建合并请求，并将编号、链接、源分支、候选提交和 QA 版本保存在 Mastra Store 后结束。交付 SHALL NOT 合并请求、直接写入 `main` 或主动触发 CI/CD 与部署。

#### Scenario: Approved QA reaches repository delivery

- **WHEN** 质量审阅通过且候选及正式规格与原生 Run 记录一致
- **THEN** 交付 SHALL 仅将已授权的候选变更追加到对应 Run 分支，并核对合并请求的仓库、目标 `main`、源分支和提交
- **AND** fixture SHALL 完成控制流验证且 SHALL NOT 写远端或产生真实 MR 回执

#### Scenario: A reviewer checks out the delivered candidate locally

- **WHEN** 工作台读取到已核验的 MR 回执
- **THEN** 交付页 SHALL 展示该回执的源分支和完整候选提交号，并提供可复制的 Git 命令，从交付仓库拉取源分支、以固定提交创建独立 worktree

#### Scenario: The remote request succeeds before the workflow records its receipt

- **WHEN** 用户在交付失败暂停点重试相同交付版本
- **THEN** 系统 SHALL 核对已存在的候选提交和合并请求并复用匹配的回执
- **AND** 版本漂移、交付目标异常或远端操作失败 SHALL 停在交付节点，保留已通过的 QA 结果

### Requirement: Registered Git projects supply versioned engineering constraints

服务端 SHALL 维护可供同一实例并发使用的业务项目注册表。客户端 SHALL 只提交登记项目 ID；Run 初始化 SHALL 冻结项目、仓库根与 origin 的绑定摘要、revision、Adapter 与 profile，原生步骤 SHALL 在资产和执行适配之前按 Run 校验，禁止修改共享配置。产品上下文、候选、归档、同步、恢复、后继与 MR SHALL 使用 Run 绑定。资产文件与交付包 SHALL 显式选择项目，不能仅凭散列跨仓库定位。后继 SHALL 保持来源项目与仓库并可采用该项目新 revision。历史单项目和 HRM 保持兼容。

#### Scenario: Human decisions use the authenticated workbench account

- **WHEN** 用户提交需求澄清、产品审阅、项目交接或后续人工关口决定
- **THEN** 服务端 SHALL 验证工作台会话并以登录账号记录决定人，不得信任客户端提交的 reviewer/operator
- **AND** 工作台 SHALL 展示登录账号，不要求重复填写审核人；未登录 SHALL 拒绝写入

#### Scenario: Workbench session survives a service restart

- **WHEN** 工作台账号已登录且服务使用相同数据目录重新启动
- **THEN** 有效的 HttpOnly Cookie SHALL 对应持久化的令牌摘要并恢复登录身份，原始令牌 SHALL NOT 落盘
- **AND** 主动退出 SHALL 持久撤销当前会话，过期会话 SHALL 失效

#### Scenario: Registered project enters the normal delivery workflow

- **WHEN** 用户创建 Run 并确认当前项目目录散列
- **THEN** 产品、开发和测试 SHALL 消费各自的固定 SDD，研发 SHALL 使用已登记的候选源码与检查
- **AND** 页面和 Agent SHALL NOT 提供宿主根路径、替换保护检查或扩大可写范围
- **AND** Spec 正文 SHALL 作为版本化资料进入角色上下文，权限与批准 SHALL 由平台和团队原有门禁决定

#### Scenario: Development reads applicable project instructions before planning

- **WHEN** 固定工程版本在仓库根目录或已登记源码、检查文件的祖先目录中包含普通文件 `AGENTS.md`
- **THEN** 项目适配 SHALL 按从根到具体目录的顺序自动发现并冻结这些文件，将其作为只读 `instructionFiles` 纳入研发候选和目录散列
- **AND** 上下文 Agent SHALL 在生成项目规则前实际读取全部 `instructionFiles`；缺失读取 SHALL 作为可恢复的输出校验失败，不能继续方案生成
- **AND** 未适用于已登记候选路径的 `AGENTS.md` SHALL NOT 自动进入上下文，项目规则 SHALL NOT 扩大 manifest 的源码写入范围、保护检查或执行权限

#### Scenario: A subsequent Run adopts a newer engineering revision

- **WHEN** a source Run belongs to the same registered project and repository, and its confirmed Git receipts verify
- **THEN** a subsequent Run SHALL use the currently registered engineering revision and preserve the source specification provenance
- **AND** resuming an existing Run SHALL require its original engineering revision

### Requirement: Team loops expose a shared envelope and versioned rework port

新建团队 Workflow SHALL 使用 `team-run-envelope.v1` 投影公共运行语义，跨团队返工 SHALL 使用 `rework-request.v1` Port。投影和 Port SHALL NOT 替代 Mastra Workflow/Store 或团队专业状态。

#### Scenario: Testing returns implementation findings to development

- **WHEN** 测试退回研发责任缺陷
- **THEN** 测试 SHALL 提交绑定研发版本、checkpoint、finding 和证据的版本化请求
- **AND** 研发 Port SHALL 在校验预算与证据后产生下一研发状态，测试 SHALL NOT 修改研发内部字段

### Requirement: Registered project adapters are selected and frozen per Run

客户端 SHALL 只提交服务端登记项目 ID。Run SHALL 冻结项目、Git revision、Adapter 与 profile hash；Adapter SHALL 生成固定检查计划且不得接受任意命令。
Adapter profile SHALL 绑定检查实现及运行时身份；Python SHALL 冻结解释器版本和可执行文件摘要，并在执行前拒绝漂移。

#### Scenario: Node and Python projects execute protected checks

- **WHEN** 两类登记项目进入正常流程
- **THEN** 系统 SHALL 从固定提交装配并运行各自固定检查，保存真实进程与候选未漂移证据

#### Scenario: Concurrent projects and native recovery remain isolated

- **WHEN** 同一实例并发运行两个登记项目，或通过 Studio 原生入口启动、恢复 Run
- **THEN** 每个原生步骤 SHALL 在资产及执行适配之前校验其 Store 中冻结的项目绑定，并仅使用对应项目的上下文、仓库和候选
- **AND** 重启恢复 SHALL 重新校验固定 revision、仓库绑定和 Adapter profile，项目篡改 SHALL 被拒绝
- **AND** 资产文件及交付包查询 SHALL 显式选择登记项目，不能仅凭跨仓库可能相同的资产散列定位文件
- **AND** 后继 Run SHALL 保持来源项目与仓库，允许采用该项目当前登记的新工程 revision

#### Scenario: Native entry attempts to replace an initialized project

- **WHEN** Studio 或其他原生调用者尝试重新 start 已初始化 Run，或通过 timeTravel 及其上下文替换重新初始化该 Run 的项目
- **THEN** 系统 SHALL 在框架重写快照、登记资产或执行远端操作之前拒绝请求
- **AND** 校验 SHALL 同样覆盖原生异步和流式入口，不能仅依赖 HTTP 请求校验
- **AND** 已保存的项目绑定 SHALL 保持不变，恢复 SHALL 继续由 Mastra 原生 API 和 Store 执行

#### Scenario: Concurrent platform repair notifications reference the same pause

- **WHEN** 多个进程对同一故障和检查点发送平台修复通知
- **THEN** 接续 SHALL 使用 Mastra Store 的原子执行认领，并在调用原生恢复前确认被认领快照仍包含所通知的暂停版本
- **AND** 过期通知 SHALL NOT 等待并消费后续人工审批暂停，也 SHALL NOT 将其改写为失败
- **AND** 只有 Store 保存的当前事件回执所属请求 SHALL 返回已接受；其他同故障通知 SHALL 返回重复或处理中，不能重复执行修复副作用

### Requirement: Workbench groups execution by responsible team

工作台 SHALL 按产品、研发、测试、交付四个团队展示 Run 执行链路。首次需求澄清、下游业务缺口的人工澄清及修订稿审阅 SHALL 归入产品团队，MR 提交及重试 SHALL 归入交付团队。

#### Scenario: Workbench follows actual Run progress and rework

- **WHEN** Run 更新当前步骤、暂停关口或明确的返工证据
- **THEN** 工作台 SHALL 根据服务端 Run 快照更新团队节点，仅在存在可确认的运行证据时展示对应的返工、回流或交付重试提示
- **AND** 没有上述运行证据时 SHALL 隐藏整行提示
- **AND** 待执行、等待确认、受阻及完成 SHALL 可区分，只有实际的交付完成结果才将四个团队全部标为完成
- **AND** 产品交互和恢复入口 SHALL 继续提交给相应原生关口

#### Scenario: Product details show four execution steps

- **WHEN** 用户打开产品团队详情
- **THEN** 工作台 SHALL 按对齐需求、生成待审规格、独立质量审查、人工审批与交接展示四个节点及中文职责说明，状态来自当前 Run 的执行证据
- **AND** 原始节点和 Agent 活动 SHALL 默认折叠并可展开查看，当前人工操作与可恢复失败的重试入口 SHALL 可直接访问
- **AND** 方向对齐期间展示的 AI 建议 SHALL 标记为初稿，当前审批状态以审阅交接的执行证据为准

#### Scenario: Development team executes six business steps

- **WHEN** 新 Run 进入研发团队
- **THEN** 默认流程 SHALL 依次执行确认项目与权限、生成开发方案、独立就绪审查、人工审批开工、按方案实施与验证、独立代码评审与交接，并在工作台显示中文职责说明
- **AND** 上下文与组队 SHALL 归入方案步骤。就绪疑问及代码评审发现 SHALL 在对应审查步骤内按需暂停。固定检查、并行任务检查点、人工批准和确定性交付校验 SHALL 继续生效
- **AND** 恢复 SHALL 复用已保存的上下文、候选版本、成功任务和累计预算。业务缺口 SHALL 按既有机制回流产品。历史 Run SHALL 可使用创建时的执行图恢复

#### Scenario: Switching teams restores their saved deliverables

- **WHEN** 用户在执行链上切换团队
- **THEN** 工作台 SHALL 在所选团队展示其已保存成果，当前执行的实时输出与操作位于所属团队
- **AND** 产品团队的审阅交接 SHALL 展示与人工批准绑定的版本。正式规格发布后 SHALL 以固定提交的文件作为正文入口，在仓库地址可确定时提供查看链接
- **AND** 刷新 Run 后 SHALL 可从原生快照回读上述成果

#### Scenario: Business documents present structured plain-text blocks

- **WHEN** 工作台呈现需求与规格正文中的 `text` 围栏
- **THEN** 可明确识别的状态流转、分组字段和顺序流程 SHALL 分别呈现为状态表、分组列表和步骤列表
- **AND** 其余 `text` 围栏 SHALL 保留原有文字和换行，其他代码围栏 SHALL 继续按代码呈现
- **AND** 阅读样式 SHALL 不修改已保存文档及其版本标识

### Requirement: Workbench displays saved candidate changes

研发工作台 SHALL 提供默认收起的代码变更入口。用户打开后，工作台 SHALL 在右侧展示相对该轮开发输入基线的候选差异，文件可独立折叠并纵向浏览。

#### Scenario: A reviewer opens the candidate changes

- **WHEN** 用户打开研发页的代码变更栏
- **THEN** 服务端 SHALL 只展示当前 Run 已保存检查点中属于已批准任务范围的变更，核对候选散列，并标明对比版本。共享文件 SHALL 只展示一份差异，并标明批准方案中的关联任务
- **AND** 无可用检查点、候选不一致或正文超出展示上限时，工作台 SHALL 明确显示对应状态

### Requirement: Product workflow focuses on direction, specification and handoff

默认产品团队 Workflow SHALL 以对齐需求、生成待审规格、独立质量审查、人工审批与交接推进。逐项澄清 SHALL 复用已收敛的方向结论进入规格写作。AI 主动补全 SHALL 先形成可观察的方向建议，再写作。方向判断 SHALL 覆盖目标、用户与场景、范围与非目标、业务决策及假设。独立产品审查 SHALL 保留为规格质量检查。研发交接 SHALL 绑定人工批准的产品版本。

缺少公司人事及法务/隐私负责人书面数据生命周期规则时，产品稿 SHALL 明确仅合成数据可研发验收、真实资料导入及正式发布仍受阻；已收敛的受控开发范围 SHALL 可形成待审规格，不得以虚构期限代替制度或让该发布依赖反复阻塞产品澄清。
对已明确回答且仅反复出现的外部制度题，需求对齐 SHALL 在其他业务维度均清晰时保留发布待决并允许进入产品写作；尚未生成的文档不作为其自身生成前的门槛，其他必答业务问题保持阻断。
需求成熟度评估 MAY 使用从原生 Run 历史派生的紧凑证据视图，保留每轮显式回答、补充与审阅身份的可追溯性；不得修改或丢弃原生历史，也不得将未回答的推荐提升为确认事实。正式产品稿仍须读取完整来源材料。

#### Scenario: Product roles use portable Markdown layouts

- **WHEN** 产品经理使用包含版式规范的需求交接 Skill 撰写或修订产品文档
- **THEN** 文档中的状态流转 SHALL 使用状态表，处理结果字段 SHALL 按业务阶段分组，顺序流程 SHALL 使用编号步骤
- **AND** 独立产品审查 SHALL 检查适用段落的版式与业务语义，并将发现记录为审查意见
- **AND** 非文档阶段 SHALL 继续使用各自的输出契约

#### Scenario: Native workflow matches the product phases

- **WHEN** 服务按默认配置装配产品团队 Workflow
- **THEN** `product-team` SHALL 依次包含 `align-product-requirements`（对齐需求）、`product-writing`（生成待审规格）、`review-product-quality`（独立质量审查）和 `review-product`（人工审批与交接）四个直属步骤，各步骤 SHALL 有中文职责说明
- **AND** 逐项澄清与 AI 主动补全 SHALL 在对齐需求步骤内执行。逐项澄清的每轮模型判断、人工回答与再评估 SHALL 使用该步骤的原生暂停和恢复，保存回答和版本校验
- **AND** 待审版本固化 SHALL 随写作一起完成，独立审查 SHALL 保留原生检查点，人工审批 SHALL 保留原生暂停和恢复
- **AND** 既有 Run SHALL 可使用创建时对应的流程图恢复，保留其原生步骤路径

#### Scenario: Human decisions advance the product workflow

- **WHEN** 用户提交关键回答并要求推进，且重新评估确认各业务维度明确且无必答缺口
- **THEN** 默认产品流程 SHALL 直接进入完善规格，无需再次点击确认
- **AND** 若仍存在必答缺口，系统 SHALL 在已版本化的人工关口展示该轮问题

#### Scenario: Feedback reopens the appropriate product phase

- **WHEN** 用户在生成中纠偏或退回产品稿
- **THEN** 产品团队 SHALL 根据影响选择重做方向或规格，保留仍有效的人工决定与前序成果
- **AND** 修订版本 SHALL 重新提交人工审阅

### Requirement: HRM CIP engineering execution

HRM 的 CIP 基线 SHALL 在确认开发范围时绑定 Git 提交。研发与 QA SHALL 在隔离环境中使用同一提交装配工程，对已批准源码变更运行固定检查。模型候选 SHALL 只包含受控的源码和规则视图。平台 SHALL 拒绝修改保护检查、切换已批准工程版本及交付不匹配的候选。

#### Scenario: Resume an HRM Run at the engineering gate

- **WHEN** 已获批的 HRM Run 在开发范围确认处选择 CIP 工程
- **THEN** 服务端 SHALL 核对产品规格分支的工程基线，并用固定检查验证实际候选
- **AND** 交付 SHALL 绑定该工程基线和同版本 QA 证据


### Requirement: Development approval includes a readable architecture document

新建 live 主线 Run SHALL 在原有开工关口展示可阅读的开发架构正文、影响范围、架构图和关键业务数据流图，并与结构化任务、就绪评估和批准版本共同绑定。运行事实与人工决定仍由 Mastra Store 持有。

#### Scenario: A new implementation plan is ready for human review

- **WHEN** 研发负责人依据批准需求与受控工程基线生成无阻塞开发方案
- **THEN** 方案 SHALL 包含目标与边界、影响范围、设计与接口数据变更、两类带方向和语义的图、实施与验证、风险及回滚说明
- **AND** 独立就绪审查 SHALL 核对文档与需求、任务、接口和实际仓库依据之间的一致性，宿主 SHALL 拒绝缺失章节或非法图引用
- **AND** 工作台 SHALL 在批准前展示正文和图，且正文或图变化 SHALL 使旧批准失效

#### Scenario: The human approves the current development package

- **WHEN** 新建 live Run 的当前方案通过人工批准
- **THEN** 系统 SHALL 将可阅读的架构文档与结构化开发规格写入同一正式 Run 分支的同一次提交，并将两条路径记录在正式回执中
- **AND** 已保存的历史 Run SHALL 按原格式、方法版本及原生暂停点恢复


### Requirement: Browser QA supports local headed debugging

已批准的浏览器用例 SHALL 默认使用无窗口 Chromium。后端启动时显式开启 `MASTRA_BROWSER_QA_HEADED` 后，执行器 SHALL 在后端桌面会话中打开独立 Chromium 窗口执行用例。

#### Scenario: An operator observes an approved browser case

- **WHEN** 后端以 `MASTRA_BROWSER_QA_HEADED=true` 启动并执行已批准的浏览器用例
- **THEN** 浏览器 SHALL 在用例结束或失败后关闭，并按既有质量关口展示实际结果和已保存的截图
- **AND** 启动失败 SHALL 记录为 `blocked`，展示模式 SHALL 仅由后端配置决定

### Requirement: Project workbench keeps review and input in one workspace

工作台 SHALL 按服务端登记项目展示需求；同实例多项目模式 SHALL 提供项目选择，新建需求只提交项目 ID。新建需求 SHALL 使用位于主栏底部的通用输入区，提交原始描述并生成列表显示标题。已有 Run 的冻结项目绑定和权限 SHALL 继续由服务端校验，切换工作台项目 SHALL NOT 更改已有 Run 归属。

#### Scenario: Select a registered project before creating a Run

- **WHEN** 同一实例登记多个项目，用户选择项目并创建需求
- **THEN** 页面 SHALL 按所选项目展示需求和同步设置，并向创建入口提交已登记 `projectId`
- **AND** 服务端 SHALL 拒绝缺失或未知项目 ID、客户端仓库路径或版本覆盖，以及复用同一 Run ID 更换项目
- **AND** 打开已有 Run SHALL 使用其冻结项目显示资料；一个不可恢复或不可读的 Run SHALL NOT 阻断其他项目需求列表

#### Scenario: Review the current decision without leaving the requirement

- **WHEN** 用户打开需求或进入一个人工关口
- **THEN** 工作台 SHALL 在主栏先展示可折叠的真实执行记录，再展示当前人工操作
- **AND** 运行中的阶段状态 SHALL 在执行记录中展示。重复阶段名称和等待提示的卡片 SHALL NOT 另行显示。失败诊断与恢复入口 SHALL 保留
- **AND** 流程导航 SHALL 按需打开，正文、候选差异和验收证据 SHALL 在按需展开的材料栏中展示
- **AND** 审批材料与提交 SHALL 继续使用同一快照版本标识

#### Scenario: Write in the shared composer

- **WHEN** 用户新建需求或补充当前需求
- **THEN** 输入 SHALL 保持在主栏底部，并以明确的提交操作区分需求创建、表单草稿和本机记录
- **AND** 没有服务端附件接收能力时 SHALL 明示图片仅供本机草稿预览，不随需求进入流程

#### Scenario: Dictate into a workbench draft in the browser

- **WHEN** 用户在支持语音识别的浏览器中主动开启麦克风
- **THEN** 工作台 SHALL 使用浏览器语音识别，将识别文字追加到可编辑草稿，等待用户提交
- **AND** 输入区 SHALL 在录音时显示状态且不向 Mastra 转写入口上传音频
- **AND** 浏览器不支持、权限被拒绝或识别失败时 SHALL 保留现有草稿并显示提示

#### Scenario: Switch execution nodes during a live connection

- **WHEN** 受控实时输出关联到一个节点及角色轮次
- **THEN** 页面 SHALL 保留当前页面会话中已收到的其他节点输出，状态和审批继续以服务端快照为准
- **AND** 节点及并行任务的标识 SHALL 由执行端提供，同角色并行任务的输出独立展示

### Requirement: Development tasks hand off shared files through dependencies

研发 v2 方案 SHALL 允许多个任务分阶段写入同一授权文件。宿主 SHALL 校验同一文件的写入任务由直接或间接 `dependsOn` 形成明确顺序。同一执行波次每个文件 SHALL 至多有一个写入任务。项目写入上界、受保护检查、任务级路径限制与方案审批 SHALL 继续生效。

#### Scenario: A downstream task extends a shared file

- **WHEN** 已批准任务通过依赖顺序写入同一文件
- **THEN** 后续任务 SHALL 在前序任务成功合并后从当前候选检查点读取文件。前序失败时后续 SHALL 等待，恢复时 SHALL 保留已成功合并的任务

#### Scenario: Tasks have conflicting paths

- **WHEN** 同一任务重复声明路径、无依赖顺序的任务声明写入同一文件，或方案声明未授权路径
- **THEN** 宿主 SHALL 在批准前拒绝方案，并区分重复路径、未排序写入与未授权路径。派发和合并 SHALL 拦截同批写入冲突

#### Scenario: A saved development run resumes

- **WHEN** 研发 Run 已绑定历史任务交接方法
- **THEN** 系统 SHALL 按所绑定版本继续规划或执行，并继续校验原有批准和恢复散列

# mastra-role-resources Specification

## Purpose

该规范描述 Mastra 主线中角色资源、需求入口、Run 运行事实、人工关口和工作台只读投影的
稳定边界。Mastra Store 持有 Workflow 执行、审批和恢复事实；角色资源、时间线和活动流
只能基于这些事实提供受控投影。

## Requirements

### Requirement: Product approval facts accompany development handoff

当 Workflow 已对当前产品版本保存批准，研发与阻塞澄清 SHALL 接收与产品摘要一致的宿主审批事实；产品正文中生成时的审批状态仅代表当时文档内容，不能覆盖后续审批事实。缺少匹配批准时 SHALL NOT 补造已批准状态或放行研发。

#### Scenario: Approved product contains an earlier pending-approval statement

- **WHEN** 产品稿仍包含生成时的待审批说明，且 Workflow 已批准同一产品版本
- **THEN** 研发和阻塞澄清 SHALL 获得与当前产品版本绑定的实际批准事实
- **AND** 产品正文和人工审批记录 SHALL 保留原样
- **AND** 技术方案生成阶段 SHALL 说明该方案须在生成和就绪审查后才进入独立审批，不能把尚未发生的后续审批当作生成方案的业务前置条件
- **AND** 就绪审查阶段 SHALL 将技术方案审批识别为后续独立关口，不能将就绪报告本身视为实施授权

#### Scenario: Development blocker is converted to a question

- **WHEN** 模型生成开发阻塞问题
- **THEN** 必答问题 SHALL 引用实际业务阻塞并标记阻塞研发，可选问题 SHALL 不引用阻塞且不阻塞流程
- **AND** 宿主仍 SHALL 校验所有已登记业务阻塞被覆盖

#### Scenario: Readiness output violates a known validation constraint

- **WHEN** 就绪报告引用未知事实或遗漏需求与任务覆盖等已登记约束
- **THEN** 恢复诊断 SHALL 使用固定的约束代码区分该错误与 JSON 解析失败
- **AND** 诊断 SHALL NOT 包含模型原文、凭据或任意异常内容

### Requirement: Development fault recovery retains state identity

研发阶段发生模型输出或网络故障后，系统 SHALL 对持久化后的完整恢复状态校验原检查点和恢复摘要；同一状态经结构化序列化或字段顺序规范化后 SHALL 可安全接续，实际内容、检查点或恢复决定发生变化时 SHALL 拒绝。

#### Scenario: Invalid structured output is persisted and retried

- **WHEN** 研发故障记录同时包含模型调用证据与结构化输出诊断，暂停后经 Store 恢复
- **THEN** 系统 SHALL 验证完整保存状态并允许使用原摘要重试原阶段
- **AND** SHALL NOT 重放已完成阶段或接受被修改的状态

### Requirement: Dual requirement intake modes

产品需求入口 SHALL 支持逐项澄清和 AI 主动补全两种入口策略，并且两种策略都 SHALL 在
产品人工审批前停止。

#### Scenario: Clarify mode preserves the existing flow

- **WHEN** 用户选择 `intakeMode=clarify` 或兼容输入 `guidedIntake=true`
- **THEN** 系统 SHALL 进入 `guided-requirements`，逐轮展示高影响问题并等待用户回答
- **AND** 推荐、假设和未提交草稿 SHALL NOT 被视为已确认业务规则

#### Scenario: Browser resumes the current clarification draft

- **WHEN** 用户填写逐项澄清后刷新同一标签页，或在该标签页切换 Run 后返回
- **THEN** 工作台 SHALL 仅对匹配 Run 和方案 hash 的草稿恢复回答、补充说明和确认人
- **AND** 工作台 SHALL 展示浏览器草稿的保存状态，正式回答仍以用户提交及 Workflow 快照为准
- **AND** Workflow 推进到新方案或产品稿后，旧草稿 SHALL 不再回填

#### Scenario: Browser explains the result of submitting clarification answers

- **WHEN** 用户提交当前轮回答并请求检查业务缺口
- **THEN** 工作台 SHALL 在操作前说明根据检查结果继续澄清或生成产品稿
- **AND** 返回澄清时 SHALL 提示继续处理当前轮，返回产品稿时 SHALL 提示审阅
- **AND** 需要先继续讨论方案的用户 SHALL 可以显式提交回答并继续澄清

#### Scenario: Autofill mode generates a reviewable product draft

- **WHEN** 用户选择 `intakeMode=autofill`
- **THEN** 系统 SHALL 跳过逐项需求问答，基于原始想法生成推荐的完整需求闭环
- **AND** 产品稿 SHALL 区分用户事实、AI 建议、假设和待确认项
- **AND** 系统 SHALL 经过产品质量检查并暂停在产品人工审批
- **AND** 系统 SHALL NOT 自动批准产品稿或自动授权研发

### Requirement: Run activity is a safe read-only projection

工作台 SHALL 从原生 Workflow 快照和受控事件读取 Run 状态、阶段、工具名、相对文件路径和
耗时，而不建立第二套执行事实。

#### Scenario: Product quality review fails before human approval

- **WHEN** 产品质量审查失败且同一 Run 保存了完整待审产品稿和前序结果，后续审批与交付尚未开始
- **THEN** 系统 SHALL 在校验保存输入与版本后允许通过原生 time travel 重试该审查节点
- **AND** SHALL 保留已有产品稿，不重跑前序生成，审查完成后仍等待人工审批
- **AND** 工作台 SHALL 在失败节点附近提供直接重试入口，并使用服务端提供的恢复版本提交

#### Scenario: Workbench receives an activity refresh

- **WHEN** 浏览器读取 Run 或收到活动通知
- **THEN** 服务端 SHALL 以 Mastra Store 快照作为状态权威来源
- **AND** 通知 SHALL 只作为刷新提示
- **AND** 响应 SHALL NOT 包含隐藏推理、真实密钥、工具结果正文或任意文件内容

#### Scenario: Workbench displays workflow progress

- **WHEN** 工作台展示 Run 进度
- **THEN** 阶段看板 SHALL 使用快照中的节点和状态展示执行卡片
- **AND** 无法确定阶段归属的节点 SHALL 单独展示，不得推测其完成状态
- **AND** 动效 SHALL 随真实状态变化，并尊重用户的减少动态效果设置
- **AND** 节点投影 SHALL 提供可复现的标识、已知阶段和可确定的执行轮次；缺失事实 SHALL 保持未知
- **AND** Agent 运行中状态 SHALL 仅在运行事实可证明时展示，不得从已完成记录推断
- **AND** 当前 Run 的工作项卡片 SHALL 随同一 Run 的阶段变化移动；首次加载或切换 Run SHALL 直接定位
- **AND** 运行中的当前阶段 SHALL 优先反映快照中已知归属的正在执行的叶节点；人工关口和终态仍以对应事实为准
- **AND** 工作台 SHALL 展示当前 Workflow 节点的耗时，运行中依据节点开始时间更新，缺失时间时显示暂无数据
- **AND** 工作台 SHALL 展示当前 Run 从开始至结束或当前时刻的总历时，并区分节点耗时；总历时包含等待时间
- **AND** 澄清表单 SHALL 独立于实时活动提示渲染
- **AND** 产品生成的实时输出 MAY 展示模型普通文本增量与实际工具调用的面向用户操作名称、按工具白名单提取的安全对象及状态；搜索词、任意工具参数、工具结果正文和模型隐藏推理 SHALL NOT 转发；流式内容 SHALL 标记为未完成
- **AND** 流式片段 SHALL NOT 替代完成校验、已保存产物或人工批准；自动重试时 SHALL 区分尝试
- **AND** 工作台 SHALL 允许通过当前状态行展开或收起流程节点详情，收起时仍显示阶段和耗时

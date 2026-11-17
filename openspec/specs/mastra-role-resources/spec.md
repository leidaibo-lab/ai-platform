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

#### Scenario: Autofill mode generates a reviewable product draft

- **WHEN** 用户选择 `intakeMode=autofill`
- **THEN** 系统 SHALL 跳过逐项需求问答，基于原始想法生成推荐的完整需求闭环
- **AND** 产品稿 SHALL 区分用户事实、AI 建议、假设和待确认项
- **AND** 系统 SHALL 经过产品质量检查并暂停在产品人工审批
- **AND** 系统 SHALL NOT 自动批准产品稿或自动授权研发

### Requirement: Run activity is a safe read-only projection

工作台 SHALL 从原生 Workflow 快照和受控事件读取 Run 状态、阶段、工具名、相对文件路径和
耗时，而不建立第二套执行事实。

#### Scenario: Workbench receives an activity refresh

- **WHEN** 浏览器读取 Run 或收到活动通知
- **THEN** 服务端 SHALL 以 Mastra Store 快照作为状态权威来源
- **AND** 通知 SHALL 只作为刷新提示
- **AND** 响应 SHALL NOT 包含隐藏推理、真实密钥、工具结果正文或任意文件内容

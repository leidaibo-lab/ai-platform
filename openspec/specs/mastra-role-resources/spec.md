# mastra-role-resources Specification

## Purpose

该规范描述 Mastra 主线中角色资源、需求入口、Run 运行事实、人工关口和工作台只读投影的
稳定边界。Mastra Store 持有 Workflow 执行、审批和恢复事实；角色资源、时间线和活动流
只能基于这些事实提供受控投影。

## Requirements

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

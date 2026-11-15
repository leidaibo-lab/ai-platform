## ADDED Requirements

### Requirement: Dual requirement intake modes

产品需求入口 SHALL 支持逐项澄清和 AI 主动补全两种入口策略，并且两种策略都 SHALL 在产品人工审批前停止。

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

#### Scenario: Browser selects the intake mode

- **WHEN** 用户在新需求页面打开“AI 主动补全需求”开关
- **THEN** 浏览器 SHALL 提交 `intakeMode=autofill`
- **AND** 开关关闭时 SHALL 提交 `intakeMode=clarify`
- **AND** 页面 SHALL 说明主动补全会生成待审初稿，推断内容需要人工审阅

#### Scenario: Legacy guided intake remains compatible

- **WHEN** 旧调用只提交 `guidedIntake=true` 或不提交入口策略
- **THEN** `guidedIntake=true` SHALL 映射为 `clarify`
- **AND** 旧的未开启 guided intake 调用 SHALL 继续直接进入产品稿生成

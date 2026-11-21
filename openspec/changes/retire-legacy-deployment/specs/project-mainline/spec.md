## ADDED Requirements

### Requirement: Legacy deployment workflow is retired

主线 SHALL 以 MR 交付结束，不再装配旧部署、健康确认或回滚回执流程。旧部署 Run 不再支持恢复。

#### Scenario: Mainline delivery reaches MR

- **WHEN** 测试质量放行并确认同版本候选
- **THEN** 系统 SHALL 提交并核验 MR，不进入旧部署流程

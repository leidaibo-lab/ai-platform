## ADDED Requirements

### Requirement: Approved product material remains traceable without a line-count gate

开发团队 SHALL 将批准原文划分为可定位的连续阅读单元，保留每个单元的原文、起始行与摘要；不得仅因原文非空行超过固定数量而拒绝初始化。单元是待审阅的材料，不自动代表独立需求或已核实覆盖。

#### Scenario: Long approved product material

- **WHEN** 已批准产品稿超过 300 个非空行
- **THEN** 系统 SHALL 保留全部非空内容及原始行号，供角色按固定版本读取并引用
- **AND** 任务和独立评估 SHALL 显式引用实际审阅的单元；未核实的范围不得自动标记为已覆盖

#### Scenario: Historical state resumes

- **WHEN** 已保存开发状态使用旧逐行锚点
- **THEN** 系统 SHALL 保持原锚点、批准摘要及恢复校验，不在恢复时重写历史状态

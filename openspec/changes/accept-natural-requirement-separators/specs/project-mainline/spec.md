## ADDED Requirements

### Requirement: Acceptance requirement separator compatibility

系统 SHALL 接受可验收需求条目中使用竖线、中文分号或英文分号分隔业务规则与明确标记的验收预期，并将分隔符规范化用于需求内容比较；不得修改批准正文或放宽 ID、非空及覆盖约束。
产品规格任务的交付结果与需求引用之间 SHALL 同样接受上述分隔符。

#### Scenario: Chinese separator in model output

- **WHEN** 需求条目使用 `- REQ-TITLE: 校验标题；验收: 空标题被拒绝`
- **THEN** 系统 SHALL 将其识别为与竖线分隔格式等价的需求条目

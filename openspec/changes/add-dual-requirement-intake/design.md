# 设计

## 输入与持久化

主 Workflow 输入新增可选 `intakeMode: clarify | autofill`。未提供时，旧 `guidedIntake=true` 映射为 `clarify`，其他旧输入映射为 `autofill`；HTTP 入口默认 `clarify`。初始化步骤同时在 `delivery.intakeMode` 和 `delivery.intake.intakeMode` 保存策略，便于恢复、审计和页面投影。

## 执行路径

```text
clarify  -> guided-requirements -> 产品经理阶段 -> 质量审查 -> 人工审批
autofill -> 产品经理阶段（主动补全提示） -> 质量审查 -> 人工审批
```

`autofill` 不进入 `confirm-requirements`，但产品稿仍由 `review-product` 暂停等待人工决定。产品经理阶段明确要求主动选择推荐闭环，并在正文中标注推断内容。

## 兼容与安全边界

- 客户端只能提交入口策略，不能提交产品正文、审批结果或跳过人工关口的命令。
- 旧快照缺少 `intakeMode` 时按 `intake.enabled` 兼容投影。
- `autofill` 的假设不得进入“已确认业务规则”列表，也不改变后续研发授权条件。

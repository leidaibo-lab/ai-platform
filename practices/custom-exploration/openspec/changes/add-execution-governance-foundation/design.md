## Context

旧决策 [`2026-08-13-durable-run-recovery-and-acceptance`](../../../docs/decisions/2026-08-13-durable-run-recovery-and-acceptance.md) 在只有一个只读天气稳定点时有意不增加通用 Operation journal、lease 和 fencing。现在用户要求推进这些缺口，重评触发条件已经满足，但 C1/C4 现状仍不包含写操作或代码执行，因此本 change 只落地基础事实和并发边界。

## Design

### Port ownership

```text
Runtime
  -> ExecutionPolicy Port      (决策与 Hook，不持有事实)
  -> ConversationStore Port    (Operation + ToolCall + RunLease 事实)
  -> Gateway / Connector        (模型和外部资源)
```

`ExecutionPolicy` 不调用 Store。`ConversationStore` 不执行策略、不调用 Connector。Runtime 将已经归一化的操作上下文交给 Policy，策略允许后在同一事务创建 Operation 和 ToolCall；完成、失败或未知时同一事务更新两者。

### Policy contract

```js
{
  phase: "before" | "after",
  kind: "run" | "tool" | "operation",
  operation: "conversation.chat" | "image.generate" | "image.edit" | "tool.execute" | ...,
  toolName: string | null,
  effect: "read" | "write" | "external" | "unknown",
  riskLevel: "low" | "medium" | "high" | "critical"
}
```

前置返回：

```js
{
  decision: "allow" | "deny" | "confirmation_required" | "defer",
  policy: "execution-policy",
  policyVersion: "execution-policy.v1",
  reasonCodes: ["operation_allowed"],
  evaluatedAt: "..."
}
```

未知操作默认 `deny / operation_unknown`；写操作默认 `confirmation_required / side_effect_confirmation_required`；后置 Hook 接收冻结的上下文和结果，只能返回观察报告。Hook 异常只进入 `failedHooks`，不改变 Operation 或 Run 终态。

### Operation journal and ToolCall projection

`operations` 是外部动作事实，最小字段包含：`operationKey`、`idempotencyKey`、`kind`、`toolName`、`effect`、`riskLevel`、`policy`、`policyVersion`、`status`、`input`、`attempt`、`externalRequestId`、`result`、`readback`、`error` 和时间字段。

`tool_calls.operation_id` 建立明确关联。天气工具的 `ToolResult` 仍按现有 API 返回；Operation 只是增加执行证据，不改变天气恢复资格。未来有副作用工具必须独立实现 `readback`、`unknown` 和补偿，不得直接复用只读恢复器。

### Lease and fencing

`run_leases` 按 `runId` 唯一保存 `ownerId`、`fencingToken` 和 `leaseExpiresAt`。未过期 lease 只能由当前 owner 使用；过期接管会递增 token。Operation、ToolCall、Run complete/fail/reject/cancel 在存在 lease 记录时都校验 `{ownerId, fencingToken, leaseExpiresAt}`。Runtime 通过心跳 renew，失去租约后停止提交，等待新 owner 接管。

为兼容旧的直接 Store 测试和历史数据库：没有 lease 记录的旧 Run 仍可由低层 API 操作；所有新 Runtime Run 都主动 acquire lease，因此真正的多实例路径不会缺少 fencing 校验。正式启用前应把 `requireRunLease` 作为部署门禁，而不是依赖调用方自觉。

### Explicit non-goals

- Sandbox 不在本 change 内实现；未来必须为代码/脚本/插件分别验证进程或容器隔离、网络 allowlist、文件系统、CPU/内存/时间、密钥可见性、资源耗尽和逃逸。
- 有副作用恢复不承诺 exactly-once。目标是外部幂等键下可重复投递、业务回读确认；不能证明结果时标记 `unknown`，由后续人工/补偿流程处理。
- 不新增后台 Worker、持久 Timer 或跨服务事件总线。

## Failure semantics

| 事件 | 事实结果 | 是否自动重放 |
| --- | --- | --- |
| Policy deny | 不执行；可记录 `confirmation_required`/拒绝 Operation | 否 |
| 同一 idempotency key | 返回已有 Operation | 按已有状态决定，completed 不重做 |
| 只读 Connector 成功 | Operation/ToolCall `completed` | 现有天气窄恢复可读 |
| 外部响应明确失败 | Operation `failed` | 仅由策略和 retryable 决定 |
| 外部结果未知 | Operation `unknown` | 否，不能盲目重放 |
| Lease 过期或 token 不匹配 | 新 owner 可接管；旧 owner 写入被拒绝 | 旧 owner 不得继续 |

## Migration and rollback

迁移只新增表/列，不重写既有 Conversation/Message/Run 数据。旧 ToolCall 的 `operationId` 可空；新调用强制建立关联。回滚时关闭通用 Policy/Lease 装配即可，保留新事实表供审计，不删除已写入事实；如果未来 schema 需要回退，先导出 Operation/Lease 状态并按 Store 版本迁移。

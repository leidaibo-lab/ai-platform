## Why

当前 Runtime 的 `Run + ToolCall` 事实足以支撑首个天气只读恢复，但不能表达第二类外部操作的风险、策略版本、幂等键、尝试、未知结果和回读，也不能在多实例下阻止旧 owner 提交终态。继续把这些字段塞进 `tool_calls` 会让协议投影和外部动作事实耦合，最终形成不可恢复的第二套隐式状态机。

本 change 推进一层可验证的执行治理基础：统一前置 Policy/Hook、独立 Operation journal、与 ToolCall 的同事务投影，以及带 fencing token 的 SQLite RunLease。它为未来 Sandbox、写操作确认/回读/补偿和成熟 durable engine 留出 Port，不把尚未验收的能力写成当前可用。

## What Changes

- 新增版本化 `ExecutionPolicy` Port，提供 `allow`、`deny`、`confirmation_required`、`defer` 决策和稳定 reason code。
- 前置策略可以阻断操作；后置 Hook 只观察结果，Hook 失败不能反向改写已提交 Run。
- 新增 `operations` 事实表和 Store API，覆盖 planned/running/completed/failed/unknown/confirmation_required/cancelled 状态、幂等键、尝试、外部请求 ID、结果/回读和错误证据。
- 现有 ToolCall 在同一 SQLite 事务中桥接到 Operation，ToolCall 继续作为 AI SDK 工具协议投影。
- 新增 SQLite RunLease，支持 acquire/renew/release、过期接管和 fencing token；Runtime 关键 Operation/Run 写入校验 owner/token。
- 当前天气工具只读能力保持兼容，普通对话不被策略阻断；图片生成与图片编辑作为受限本地资产写入切片被显式允许，但不自动获得副作用恢复。
- 明确 Sandbox 和有副作用恢复需要后续独立方案、OpenSpec 和真实故障/安全验收。

## Capabilities

### New Capabilities

无。能力仍属于现有 `ai-platform` Agent Runtime 和治理区域。

### Modified Capabilities

- `ai-platform`：增加执行策略、Operation/ToolCall 事实桥接和 RunLease/fencing 契约。

## Impact

- Runtime：在 Run/Tool 执行前调用 Policy，获得 RunLease，向 Store 传递 lease 凭证，并隔离后置 Hook。
- SQLite：增加 `operations`、`run_leases` 和 ToolCall 的 `operation_id` 迁移。
- 测试：增加默认拒绝、幂等状态迁移、未知结果和租约竞争/旧 token 拒绝回归。
- 文档：更新执行可靠性等级和架构图状态，明确 Sandbox、写副作用恢复仍为 TODO。

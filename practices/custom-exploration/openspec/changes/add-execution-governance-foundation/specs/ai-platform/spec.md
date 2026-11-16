## ADDED Requirements

### Requirement: 版本化执行策略与 Hook

Agent Runtime SHALL 为 Run、Tool 和 Operation 执行提供可替换、版本化的执行策略 Port；未知操作 SHALL 默认拒绝。

#### Scenario: 已知会话操作被允许

- **GIVEN** 当前 Run 使用已有的 `conversation.chat` 操作
- **WHEN** Runtime 执行前置策略评估
- **THEN** 策略 SHALL 返回 `allow`、稳定 `policyVersion` 和至少一个稳定 reason code
- **AND** 没有命中工具路由的普通对话 SHALL NOT 被要求额外通过工具策略

#### Scenario: 受限本地图片资产写入被显式允许

- **GIVEN** 当前 Run 已将入口请求解析为 `image.generate` 或 `image.edit`
- **AND** Runtime 默认策略将这两个既有 C2 operation 显式注册为受限本地资产写入
- **WHEN** Runtime 执行前置策略评估
- **THEN** 策略 SHALL 对真实图片 operation 返回 `allow`，不得评估或持久化入口 `auto`
- **AND** 该显式允许 SHALL NOT 被解释为图片模型可自动重试、启动恢复或通用外部写操作已获授权

#### Scenario: 未知操作被拒绝

- **WHEN** Runtime 评估当前策略定义未注册的操作
- **THEN** 策略 SHALL 返回 `deny` 和 reason code `operation_unknown`
- **AND** Runtime SHALL NOT 调用模型、Connector 或外部执行器

#### Scenario: 副作用操作要求确认

- **WHEN** 策略评估 effect 为 `write`、`external` 或 `unknown` 的操作
- **THEN** 除非有显式规则允许，默认策略 SHALL 返回 `confirmation_required`
- **AND** Runtime SHALL NOT 将该操作静默降级为只读操作

#### Scenario: 后置 Hook 失败

- **GIVEN** Operation 或 Run 已经提交执行结果
- **WHEN** 后置 Hook 抛出异常
- **THEN** Runtime SHALL 保留已提交的执行状态
- **AND** Hook 失败 SHALL 只作为隔离的观察证据返回

### Requirement: Operation journal 是外部动作事实

Conversation Store SHALL 将 Operation journal 与 AI SDK ToolCall 投影分开持久化，并 SHALL 在同一个 SQLite 事务中完成关联 ToolCall/Operation 的状态迁移。

#### Scenario: Operation 幂等规划与启动

- **WHEN** 相同 `conversationId` 和 `idempotencyKey` 被重复提交
- **THEN** Store SHALL 返回已有 Operation，而不是创建第二个外部动作事实
- **AND** Operation SHALL 保留首次提交的策略版本和输入证据

#### Scenario: 只读 ToolCall 桥接到 Operation

- **WHEN** Runtime 启动已注册的只读 ToolCall
- **THEN** Store SHALL 在同一事务中创建一个关联 Operation，保存 `effect=read`、`operationKey`、`idempotencyKey`、策略版本和 attempt 证据
- **AND** ToolCall SHALL 继续作为当前天气契约公开的 AI SDK 协议与结果投影

#### Scenario: Operation 携带回读证据完成

- **WHEN** 外部执行器返回结果和可选 readback
- **THEN** Store SHALL 原子地把 Operation 设为 `completed` 并持久化 result/readback 证据
- **AND** 重复完成同一个 Operation SHALL 保持幂等

#### Scenario: Operation 结果未知

- **WHEN** 执行器无法证明外部副作用是否已经发生
- **THEN** Store SHALL 将 Operation 设为 `unknown` 并保存稳定 reason code
- **AND** Runtime SHALL NOT 自动重放该 Operation

### Requirement: RunLease 与 fencing 协调

Conversation Store SHALL 提供包含 owner、expiry 和单调递增 fencing token 的 RunLease Port；Runtime SHALL 在执行新 Run 前取得 lease，并在关键写入时验证 lease 凭证。

#### Scenario: 一个 owner 取得 lease

- **WHEN** 活跃 Run 不存在未过期 lease
- **THEN** 第一个 owner SHALL 取得 lease 和 fencing token
- **AND** lease 仍有效时，第二个 owner SHALL 收到稳定的 `lease_held` 结果

#### Scenario: 过期 lease 被接管

- **WHEN** 当前 lease 已经过期
- **THEN** 另一个 owner MAY 取得该 Run
- **AND** 新 fencing token SHALL 大于前一个 token

#### Scenario: 旧 owner 在接管后写入

- **WHEN** 旧 owner 使用先前 fencing token 尝试完成、失败或更新 Operation
- **THEN** Store SHALL 用稳定 reason code `stale_fencing_token` 拒绝写入
- **AND** 新 owner 的事实 SHALL 保持不变

#### Scenario: Runtime 丢失 lease

- **WHEN** lease 续租失败或 fencing token 被拒绝
- **THEN** Runtime SHALL 停止提交新的模型或 Connector 结果
- **AND** 该 Run SHALL 保持可由后续 owner 分类或恢复

### Requirement: Sandbox 与副作用恢复保持门禁

平台 SHALL NOT 仅凭 Policy、Operation 或 Lease 基础就宣称通用 Sandbox 或副作用恢复可用。

#### Scenario: 提议代码执行能力

- **WHEN** 后续能力提议执行任意代码、脚本、文件或命令
- **THEN** 该能力 SHALL 先独立定义进程或容器隔离、网络 allowlist、文件系统、资源限制、密钥可见性和逃逸测试的 Sandbox 策略
- **AND** 在该决策被接受前，当前只读工具 Runtime SHALL 保持不变

#### Scenario: 提议副作用恢复能力

- **WHEN** 后续能力可以修改外部系统
- **THEN** 在启用自动恢复前，该能力 SHALL 定义确认、外部幂等、业务 readback、`unknown` 处理和 compensation
- **AND** 平台 SHALL NOT 仅因存在 Operation 记录就宣称 exactly-once 执行

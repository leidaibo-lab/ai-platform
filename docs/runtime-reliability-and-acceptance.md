# 运行可靠性与结果验收

Agent Loop 回答“下一步做什么”，运行可靠性回答“中断后从哪里继续”，结果验收回答“系统凭什么接受已经完成”。三者必须分开表达：模型返回正文不是执行完成，SQLite 保存状态也不等于执行能够恢复。

## 两条演进轴

### 执行可靠性

| 等级 | 能力定义 | 必要证据 |
| --- | --- | --- |
| R0 可执行 | 模型可以生成文本或请求工具 | 一次主路径结果 |
| R1 可记录 | Run、Message、ToolResult 或 Artifact 有唯一事实源 | 持久化状态和事件 |
| R2 可重放 | 幂等重试或重复请求不会重复提交已知结果 | 幂等键、终态重放和调用次数 |
| R3 可恢复 | 进程重启后能从最近稳定提交点继续剩余执行 | 绝对截止时间、稳定提交点和进程故障场景 |
| R4 可协调 | 多实例可以安全争抢、接管和处理未知副作用 | lease、fencing、业务回读、补偿和并发演练 |

### 结果可信度

| 等级 | 能力定义 | 必要证据 |
| --- | --- | --- |
| A0 模型声明 | 模型返回非空正文或声称任务完成 | 模型候选输出 |
| A1 结构校验 | 输出格式、schema、MIME、尺寸或字段约束通过 | 确定性校验结果 |
| A2 事实绑定 | 输出能关联 ToolResult、Artifact、来源、版本或数据时间 | 稳定事实 ID 和来源摘要 |
| A3 系统验收 | 独立于生成模型的领域规则确认结果满足完成条件 | 持久化 AcceptanceResult |
| A4 人工确认 | 授权用户确认高风险结果或副作用 | 审批身份、版本和决定事实 |

R 与 A 是正交关系。一个任务可以可恢复但结果不可信，也可以结果可校验但进程重启后无法继续。项目不得用单一“已完成”掩盖二者差异。

## 当前能力定位

| 场景 | 执行可靠性 | 结果可信度 | 当前依据 | 仍未覆盖 |
| --- | --- | --- | --- | --- |
| 普通 C1 对话 | R2 | A0 | Run/Message 持久化、幂等重放、统一重试和终态查询 | 自然语言事实正确性没有独立验收 |
| 天气只读工具 | 受限 R3 | A3 | completed ToolResult 后可在服务重启时恢复最终总结；天气 AcceptanceResult 检查地点、数据时间、来源和结果事实 | 只覆盖确定性路由的 `get_weather`；真实模型质量、多实例和复杂多工具未验收 |
| C2 图片生成开发切片 | R2 | A2 | 幂等重放、图片字节/MIME/尺寸校验、ImageAsset 元数据和哈希 | 进程崩溃窗口、内容安全、语义质量和正式对象存储未完成 |
| C6 写操作 | 未实现 | 未实现 | 已有 ExecutionPolicy、Operation journal、RunLease/fencing 和 `unknown` 门禁；尚无外部写 Connector | 确认身份与版本、外部幂等、业务回读、人工处置、补偿和真实故障验收 |
| C7 批量任务 | 未实现 | 未实现 | 无 | 分片、调度、跨实例恢复、覆盖率和汇总验收 |

“受限 R3”只表示一个已证明的稳定点：`Run=running`、原用户消息存在、全部 ToolCall 是已注册的 completed 只读调用、ToolResult 已提交、助手消息未提交且原截止时间未耗尽。它不等于通用 Durable Harness。

当前另有一层不单独提升场景等级的 R4 协调基础：所有新 Runtime Run 都取得带 owner、expiry 和单调 fencing token 的 SQLite `RunLease`；未过期 lease 会阻断其他 owner，过期后允许接管，旧 token 的 Operation/ToolCall/Run 写入被拒绝。它已通过两个 SQLite 连接和进程故障场景验证，但还没有共享生产数据库部署、跨实例取消路由、长任务 Worker、业务回读或补偿，所以普通 C1、天气和图片场景均不宣称达到 R4。

## 当前执行对象

```text
Conversation
  -> Run
      -> RunLease(owner / expiry / fencing token)
      -> Operation(execution fact)
          -> ToolCall(AI SDK projection)
              -> Evidence: ToolResult / readback
              -> Candidate Output
                  -> AcceptanceResult
                      -> Message + Run terminal fact
                          -> Delivery
```

- `Conversation`：长期会话事实和上下文边界。
- `Run`：一次用户请求、幂等身份、模型、绝对截止时间和 ChainTrace 关联。
- `RunLease`：当前 Run 的 owner、过期时间和 fencing token；Store 在关键写入校验，终态事务内释放。
- `Operation`：外部动作的独立执行事实，保存操作键、幂等键、effect/risk、策略版本、attempt、外部请求 ID、结果、回读和错误状态。
- `ToolCall`：AI SDK 工具协议与 ToolResult 投影，通过 `operationId` 关联 Operation；当前 Runtime 仍只执行已注册只读工具。
- `Evidence`：ToolResult、来源和数据时间；未来可扩为 Artifact、回读或测试结果。
- `Candidate Output`：模型生成但尚未被系统接受的候选，不能直接等同完成。
- `AcceptanceResult`：策略、版本、accepted/rejected、原因码和最小证据摘要。
- `Message + Run terminal fact`：只有验收通过的受管候选才能在同一事务成为助手消息和 completed Run。
- `Delivery`：终态事实形成后的渠道投递；当前连接失败不反向改写 Run，渠道可按幂等键或 `latestRun` 取回。

`Operation` 与 `ToolCall` 在同一 SQLite 事务中创建和更新，但两者职责不同：前者是执行 journal，后者是模型工具协议投影。当前天气只读工具已经桥接到 Operation；通用 `planned/running/completed/failed/unknown/confirmation_required/cancelled` 状态机和 readback 门禁已经存在，但没有接入任何外部写 Connector。`unknown` 没有业务回读时既不能自动完成或失败，也不得自动重放。

## 首期恢复流程

```text
进程 1
  Run + 用户消息已提交
    -> get_weather completed ToolResult 已提交
      -> 进程退出

进程 2
  扫描 running Run
    -> 未过期 RunLease: lease_held，不提前接管
      -> lease 过期后以更大 fencing token 接管
    -> 校验操作、工具效果、ToolResult、消息和原截止时间
      -> 从 SQLite 重建上下文与结构化工具消息
        -> 无 ToolSet 总结，不执行 Connector
          -> 独立天气验收
            -> accepted: AcceptanceResult + 助手消息 + run.completed 同事务提交
                -> 释放暂存正文；当前渠道失败不改写 Run
            -> rejected: AcceptanceResult + run.failed 同事务提交，不保存候选正文
```

图片生成、无 completed ToolResult、运行中或失败工具、未知工具、未知副作用和已超时 Run 都不会自动重放。未过期 lease 只会让恢复候选保持 skipped；取得 lease 后，不满足窄恢复资格的 Run 才用稳定原因码收口为 failed，并保留原用户消息和已有工具或资产事实。

## 完成与交付边界

普通 A0 对话仍会边生成边交付，因此 `outputStarted` 是模型重试的不可逆边界。需要 A3 验收的天气候选则先暂存，只有 AcceptanceResult、助手消息和 Run 终态完成原子提交后才释放正文。此时执行已经完成，渠道回调失败只能记录为 Delivery 失败，不能再生成 `run.failed`、重复 Connector 或改变 AcceptanceResult。

当前没有持久化逐渠道投递状态、回执或消息队列。若未来要求保证多渠道至少一次送达，需要新增独立 DeliveryAttempt/Outbox 事实、渠道幂等键和重试策略；不得把它们塞回 Run 执行状态。

## 版本化双模式场景资产

每个 Runtime 故障场景固定拆为：

```text
scenario/
  case.json                 输入、ToolResult fixture 和故障退出码
  deterministic-model.mjs  根据可见消息和持久化观察决定 Tool Call 或候选输出
  acceptance.mjs           读取最终 SQLite 事实并独立判定场景
  README.md                 说明能力边界
```

`case.json` 由 `runtime-scenario.v1` 校验，包含 fixture 版本、支持模式、Prompt 版本、固定生成参数、Run、故障和只读工具 fixture。通用 Runner 只负责临时数据库、两个 Node 进程、故障执行、恢复执行和证据采集，不包含天气业务分支。新增场景应优先增加目录资产；只有执行协议变化时才修改 Runner。

```text
setup（固定行为模型）
  -> 现有 Runtime / Tool Registry
  -> completed ToolResult 后退出

evaluation
  deterministic -> 固定行为模型验证 Runtime / SQLite / Acceptance
  real-model    -> GatewayClient -> AI SDK -> LiteLLM -> 上游模型
```

```bash
npm run test:acceptance
npm run test:governance
npm run test:scenarios
npm run eval:runtime-scenarios:deterministic
npm run eval:runtime-scenarios:real -- --model <fixed-model-alias>
```

真实模式不提供默认模型别名；无论使用 npm 入口、直接调用 Runner 或由其他 AI 项目装配，调用方都必须通过 `--model <fixed-model-alias>` 显式固定该项目的模型别名。

两个模式复用同一份场景输入、ToolResult 和独立验收。真实模式只把 evaluation 计入质量、token 和延迟；setup 单独记录。报告区分模型请求数、完成响应数和失败数，实际模型只从完成响应读取。上游超时、鉴权、限流、网关错误或验收失败都直接失败，不允许回退固定模型。

当前确定性结果为 `2/2`：成功恢复场景完成原 Run，拒绝场景以 `weather_source_missing` 收口，两个场景重启后 Connector 调用均为 0。真实 `gpt-5.6` 单样本已进入现有 Gateway 主链，但当前上游连接在 120 秒原 Run 截止时间内超时，结果为 `0/1`；该结果只证明真实模式和失败证据链生效，属于 `observation-only`，不构成质量基线。

首期将协议、Runner 和 CLI 保持为仓库内稳定逻辑模块，不立即拆包或新增服务。同仓通过增加场景目录扩展；独立 AI 项目保持 `runtime-scenario.v1`、固定模型、Acceptance 和报告语义，通过装配层接入自己的 Runtime。出现第二个稳定消费方后再评估独立发布形态。完整协议见 [`scenarios/runtime/README.md`](../scenarios/runtime/README.md)。

## 后续扩展模板

后续每个场景或 Operation 使用同一结构表达：

```text
能力目标：
当前实现：
事实所有者：
执行可靠性：R0-R4，并说明稳定提交点
独立验收方式：A0-A4，并说明 Acceptance Policy
验证证据：主路径、故障窗口、调用次数和持久化事实
剩余边界：明确不能恢复或不能验收的情况
重评条件：何时引入成熟执行引擎或人工审批
```

出现复杂状态图、跨请求暂停或人工介入时重评 LangGraph；出现跨实例长任务、可靠 timer、不可重复写副作用和补偿时重评 Temporal；出现 workspace agent、长回合 Harness 或语义步骤切片时重评 AI SDK Workflow Harness。平台仍拥有业务 Conversation/Run、权限、ToolResult、AcceptanceResult、审计和外部交付，避免与候选引擎形成双事实源。

Sandbox 与副作用恢复仍是两条独立建设线。Sandbox 必须先定义进程或容器隔离、网络 allowlist、文件系统、CPU/内存/时间、密钥可见性和逃逸测试；首个低风险写操作必须先定义确认身份与版本、外部幂等键、业务回读、`unknown` 人工处理和补偿。Policy、Operation row 或 RunLease 单独存在都不能证明 exactly-once。

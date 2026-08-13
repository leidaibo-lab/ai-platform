# 执行治理基础层

- 状态：接受
- 日期：2026-08-13
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 治理与可观测
- 关联需求：通用 Hook/Policy、Operation journal、多实例协调，以及后续有副作用操作恢复的执行基础
- 关联 OpenSpec：[`add-execution-governance-foundation`](../../openspec/changes/add-execution-governance-foundation/)
- 替代记录：扩展 [`首期可恢复执行与独立结果验收`](./2026-08-13-durable-run-recovery-and-acceptance.md) 中“暂不实现 Operation journal、lease、fencing”的边界

## 问题

当前 Runtime 已有 Conversation、Run、ToolCall 和 AcceptanceResult，但 `ToolCall` 只记录首个只读工具切片的协议事实，不能表达通用外部操作的风险、策略版本、幂等键、尝试、未知结果、回读或补偿证据。Runtime 也只在单进程 `conversationId` 范围串行；多个实例同时处理同一 Run 时，没有 owner 和 fencing token 阻止旧实例继续提交。

这使得当前能力可以证明天气只读恢复，却不能安全承接第二类可恢复操作、跨实例接管或有副作用动作。用户要求推进五项缺口，本阶段先交付可复用的执行治理基础层，并用真实 SQLite 事务和竞争回归证明其边界。

## 约束与非目标

### 必须满足

- Conversation Store 仍是 Conversation、Run、ToolCall、Operation、Lease 和事件事实的唯一写入所有者。
- `ToolCall` 继续表示 AI SDK 工具协议投影；`Operation` 表示外部动作的执行意图、状态和恢复证据，不能通过改名制造第二个事实源。
- 策略结果必须带不可变定义、`policyVersion` 和稳定 `reasonCodes`；未知操作默认拒绝。
- 多实例安全必须依赖 owner、租约过期时间和单调 fencing token；关键状态写入在存在租约时必须校验 token。
- 当前 `get_weather` 仍是只读工具；本阶段不得开放写工具、任意命令、任意 URL 或模型生成代码执行。

### 本次不解决

- 不把 SQLite lease 宣称为跨地域高可用调度；正式横向扩容前仍需共享数据库并发、故障注入和运维演练。
- 不实现 Sandbox。代码、脚本、不可信插件和任意文件/命令执行需要独立选择和逃逸、网络、资源及密钥隔离 PoC。
- 不实现有副作用操作的自动恢复、补偿或人工审批闭环；没有外部幂等、业务回读的系统继续进入 `unknown` 设计边界。
- 不引入 Temporal、LangGraph 或其他工作流引擎作为当前 Runtime 的业务入口。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| Temporal | 成熟一体化 | 持久执行、重试、Timer、Worker、Activity、故障恢复 | 已解决长任务事件历史、跨 Worker 协调和确定性恢复 | 引入独立服务与 Worker 运行模型；当前 C1 只有短请求和一个只读稳定点，迁移 Conversation/Run 所有权成本高 | [Temporal 文档](https://docs.temporal.io/temporal)；旧决策已记录当前不满足触发条件 |
| 数据库 journal + 策略引擎 + 外部租约 | 轻量可组合 | Operation 状态、策略、租约和外部动作 Port | 能按能力拆边界，策略和执行器可替换，适合逐步从只读扩展到写操作 | 事务、fencing、回读和补偿仍由平台组合负责；必须防止只建表不校验 token | [OPA 文档](https://www.openpolicyagent.org/docs/latest/)、[Cedar 文档](https://www.cedarpolicy.com/en)、本仓库现有 SQLite/Port 结构 |
| SQLite + 项目自有 Port | 最小自研 | 当前单仓的 Policy、Operation journal、SQLite lease/fencing | 不改现有事实源和部署方式，能用确定性回归证明幂等、状态迁移和旧 owner 拒绝 | 不提供持久 Timer、跨地域共识、Sandbox 或业务补偿；长期维护责任在平台 | `src/storage/conversation-store.mjs`、`src/runtime/`、`scripts/test-execution-governance.mjs` |

Sandbox 另行比较进程限制、容器、gVisor/Firecracker 等方案；在没有真实代码/插件执行场景前，本记录不把其中任何一个写成已选定实现。

## 淘汰条件

- 方案允许旧 owner 在 lease 过期或 token 变更后继续提交 Operation 或 Run 终态。
- Operation 只能表达“工具调用成功/失败”，不能记录幂等键、外部请求 ID、未知结果或回读事实。
- 策略失败会被当成普通模型失败，或 Hook 能在执行事实提交后反向修改已完成 Run。
- 方案要求把 LiteLLM、渠道或模型网关变成业务执行事实所有者。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 未知操作默认拒绝，当前对话和天气只读兼容 | Policy Port 单元回归 + Runtime 天气回归 | `execution-policy.v1`、`get_weather` | 通过；前置 Hook 只能收紧，后置 Hook 失败隔离 | `scripts/test-execution-governance.mjs` |
| 同一 Operation key 不会创建第二个外部动作事实 | 两次 plan/start 和 ToolCall 桥接回归 | SQLite `:memory:` 与文件库 | 通过；重复输入返回同一 Operation，ToolCall 同事务投影 | `scripts/test-execution-governance.mjs` |
| 旧 fencing token 不能完成、失败或标记未知操作 | 两个 Store/owner 竞争、过期接管、旧 token 写入 | Node `node:sqlite`、WAL | 通过；未过期返回 `lease_held`，接管后旧 token 返回 `stale_fencing_token` | `scripts/test-execution-governance.mjs` |
| 当前只读工具不会因为接入 journal 改变恢复边界 | Runtime 全量测试与天气重启场景 | 现有 C1/C4 fixture | 通过；全量 `108/108`，确定性重启场景 `2/2`，恢复后 Connector 调用为 0 | `scripts/test-runtime.mjs`、`scripts/test-runtime-scenarios.mjs` |

## 决策

- 结论：自研最小 Port，适配现有 SQLite 事实源；暂不引入成熟工作流引擎。
- 选择方案：`ExecutionPolicy` + `Operation journal` + SQLite `RunLease`/fencing adapter。Operation 与 ToolCall 在同一事务中创建和更新；Run 的关键终态写入复用同一 lease 校验。
- 决策依据：本次已经出现第二类可持久化操作事实和多实例边界的明确需求，但尚未出现长任务、写副作用或 Sandbox 场景。最小组合能先证明数据结构和并发不变量，同时保留迁移到 Temporal/外部策略引擎的 Port。
- 平台拥有：稳定状态、策略版本、reason code、幂等键、Operation/ToolCall 投影、lease/fencing 事实、事件和未来回读/补偿契约。
- 外部方案负责：AI SDK 负责模型工具协议；LiteLLM 负责模型访问；具体 Sandbox、策略产品、对象存储和业务 Connector 以后通过 Adapter 接入。
- 明确不实现：通用工作流、任意代码执行、自动 exactly-once、无证据的副作用重放。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| Temporal | 当前还没有长任务、可靠 Timer、跨 Worker Activity 或补偿链；直接迁移会扩大事实所有权边界 | 任务超过单次请求生命周期、需要持久 Timer/Worker 扩缩容、或第二个业务系统需要 durable execution |
| OPA/Cedar 直接作为本阶段运行时依赖 | 策略输入和身份模型尚未稳定，当前依赖数量和部署复杂度高于收益 | 多租户 ABAC、外部策略发布、合规审计或策略团队独立维护成为硬需求 |
| 立即实现 Sandbox | 当前没有受管代码/脚本/插件执行入口，无法定义网络、文件、资源和密钥验收矩阵 | 引入代码执行器、不可信插件、模型命令或文件操作时，先完成独立 Sandbox 决策和逃逸测试 |

## 实施边界

`ExecutionPolicy` 是 Runtime 依赖的 Port：输入是已归一化的操作上下文，输出是不可变策略决定；前置 Hook 可以阻断，后置 Hook 只能观察已提交结果，Hook 异常被隔离并进入观测报告。策略模块不访问 SQLite、不执行 Connector、不持有 provider key。

`ConversationStore` 负责 Operation 和 RunLease 的全部 SQL。允许的只读天气 ToolCall 通过 `operation_id` 指向一个 `effect=read` 的 Operation；ToolResult 仍由 ToolCall 投影公开，Recovery 仍只读取已完成只读事实。未来写操作必须先走 `confirmation_required`、幂等外部请求、回读，再决定 `completed` 或 `unknown`。

Lease 采用“保留记录、过期接管、token 单调递增”语义。释放不会删除历史 token；任何存在 lease 记录的关键写操作都必须传入匹配 owner/token 且未过期的凭证。当前没有 lease 记录的旧直接 Store 调用保持兼容，但 Runtime 新 Run 总是先取得 lease。

## 风险与退出路径

- 已知风险：SQLite 只能提供单库并发和本地锁；长时间模型调用若心跳失效会主动放弃提交，交由新 owner 接管。
- 锁定点：当前 Operation 状态 JSON 和 SQLite schema；通过 Store Port、结构化映射和迁移保留替换余地。
- 退出路径：迁移 Operation/Lease 事实到成熟 durable engine 时，保留 Conversation/Message/ToolResult/AcceptanceResult 的领域 ID，并把 Store Port 替换为外部适配器。
- 维护责任：平台 Runtime/Storage 维护者负责状态迁移、fencing 测试和租约运维；未来 Sandbox/副作用 Connector 所属团队负责其独立决策和回读/补偿证明。

## 验收与完成报告

- 验证证据：`npm run test:governance` 为 `4/4`；`npm test` 为 `108/108`；`npm run test:architecture` 为 `5/5`；`openspec validate add-execution-governance-foundation --strict`、`openspec validate --specs --strict` 和 `git diff --check` 均通过。
- 剩余边界：Sandbox、写操作确认、外部回读、补偿、未知结果人工处理和跨地域多库协调仍未完成。
- 文档与契约：同步本记录、OpenSpec change、`docs/runtime-reliability-and-acceptance.md`、`docs/ai-structure.md` 和架构边界回归。
- 重评条件：出现有副作用 Operation、批量/长任务、人工审批、第二个 Runtime 实例的生产部署、独立策略/安全团队或代码执行入口。

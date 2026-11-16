# pi 后续选型验证（2026-10-13）

## 结论

继续保留当前 AI SDK + LiteLLM 主链。pi-agent-core 可以适配，但本轮没有发现足以抵消迁移成本的代码删除收益。pi-durable 确实提供持久任务和恢复，不应按早期 CLI 能力低估；它仍不足以直接替代本项目事实与协调体系。状态保持“提议”，不转为正式采用。

## 执行范围与版本

- Node 24.19.0；AI SDK 7.0.37；Pi 的 agent-core、ai、durable 和 chord 均锁定 1.2.0。
- 正式代码入口未引用实验目录；平台业务契约未改变。
- 两套 SDK 使用同一 OpenAI-compatible fake HTTP fixture；pi-durable 使用官方 faux provider 和独立临时 SQLite。
- 模型提示、天气事实与故障输入固定；全部测试为工程回归，不报告真实模型准确率或性能优势。

## 验证矩阵

| 验证项 | 证据 | 解释 |
| --- | --- | --- |
| 第一轮工具、取消、幂等、恢复、验收 | `test-comparison.mjs` 22/22 | 两引擎各 11 个；恢复由原平台 SQLite 承担 |
| 模型别名、401、Policy、并发幂等、历史、owner 竞争、图片协议 | `test-boundaries.mjs` 18/18 | 两引擎各 9 个；包括对 Pi 多模态缺口的显式断言 |
| Pi 自有持久化/故障恢复 | `test-durable.mjs` 6/6 | 独立临时 SQLite，真实 Node 子进程崩溃/恢复 |
| 合计 | `npm test --prefix experiments/pi-agent` 46/46 | 通过意味着观测符合预期，不意味着所有候选能力达到采用门槛 |

### Pi Adapter 的新增发现

扩展测试首次执行暴露两个自有 PoC Adapter 缺陷，不属于已证明的 Pi SDK 缺陷：

1. 请求 `poc-alt` 时只校验别名，实际仍发送 `poc-chat`。已将选定模型传入每次 Agent 尝试；请求体检查通过。
2. HTTP 401 被统一归为 transient，导致平台重试两次。已通过 fetch 边界保留 HTTP 状态，401 单次结束，503 仍由平台重试；韧性证据不含 provider 正文。

Policy 测试直接通过原 Hook 和 Runtime 工具包装器拒绝 Connector。原平台双 owner 使用同一 SQLite 的竞争请求在模型执行前返回 409；这只是本地协调回归，不是生产多实例验收。

图片生成/编辑在混合 Adapter 下仍由原 AI SDK `generateImage` 和 Responses Adapter 执行。happy path、模型别名/目标端点、凭据及单次尝试通过；图片 503 不重复调用。该结果证明委托兼容，不证明 Pi 原生图片实现或真实图片质量。

Pi PoC 尚不支持平台 `image_url` 多模态输入：基线发送图像，Pi 显式拒绝且不访问 provider。测试通过的是“识别并保留缺口”，视觉能力门禁仍未通过，不能据此认定 Pi SDK 不支持图片。

### pi-durable 的恢复边界

| 故障窗口 | 恢复观测 | 平台含义 |
| --- | --- | --- |
| 工具结果已提交，下一模型请求前退出 | 工具只执行一次；重开后复用结果；相同 requestId 复用 Submission | 原生持久恢复有效 |
| 未标 safe 的工具，外部操作后、结果提交前退出 | 外部操作一次；恢复产生 `interrupted` 错误结果，没有重新执行 | 防止默认重放有效，但外部业务结果仍可能未知 |
| 标 `replay: "safe"` 的工具，同一故障窗口 | 工具重放；模拟的非幂等外部文件操作出现两次 | safe 是业务承诺，不是自动 exactly-once 或自动幂等 |
| 自定义 task 已提交下一 checkpoint 后退出 | 恢复从下一阶段继续；第一阶段一次、第二阶段一次 | 可减少任务状态机/调度自研，但阶段内副作用仍需业务保护 |
| 文档变更事务中途抛错 | 文档保持提交前值 | 内部事务原子性有效，不覆盖外部 HTTP/文件操作 |
| 两个独立 Harness 打开同一 SQLite | 都成功打开，没有独占 owner 获取 | 与官方单进程存储边界一致；不是跨进程 fencing 实测证明 |

工具中断后 Submission `done` 仅表示模型完成了对错误结果的响应，不能推导外部操作成功或业务验收通过。

## 迁移删除与新增清单

| 范围 | 采用 pi-agent-core 后 | 本轮依据 |
| --- | --- | --- |
| `ToolLoopAgent` 配置和执行包装 | 可替换 5 个专属函数块，约 82 物理行，另需调整构造/调用点 | `createToolLoopAgentInstance`、`createConversationAgentCallPreparer`、`prepareConversationAgentStep`、`shouldUseConversationAgent`、`executeConversationAgentAttempt` |
| PoC Pi Adapter | 新增 203 物理行 | 包含消息/schema/工具/事件/取消/错误/重试映射；尚未覆盖视觉、完整 Telemetry 和全部协议边界 |
| GatewayClient / AI SDK 依赖 | 仍需保留 | 结构化输出、图片生成、目录和原 Responses 编辑实现未迁移 |
| Session/Run、SQLite、Context Planner、Memory Manager | 仍需保留 | 当前事实所有者与 MemoryDelta/Manifest 契约不变 |
| RetryExecutor、Policy、Operation、Lease/fencing、AcceptanceResult | 仍需保留 | 当前 Pi 集成必须回到这些平台边界 |
| pi-durable | 可探索替换更广的 task/transcript 机制，但本轮未接入正式 Runtime | 单一数据所有者、迁移、取消、fencing 与验收映射尚未设计和验证 |

物理行包含注释，不是质量或总代价评分；Pi PoC 也复用现有 Gateway。此处只说明替换现有循环暂未显示维护量净减少，不能用 203−82 推算完整迁移成本。Pi 提供的新功能在真实业务需要长任务、子任务或可编程扩展时才可能抵消迁移代价。

## 依赖与许可检查

实验 lockfile 共 92 个 dependency package 条目。声明分布：MIT 43、Apache-2.0 35、BSD-3-Clause 12、Unlicense 1、0BSD 1；没有缺失 license 字段。新增的四个 Pi 直接依赖均为 MIT。

这是 lockfile 声明的初步检查，不等于法律审查、漏洞审计、许可证正文逐包比对或生产供应链验收。依赖只位于 PoC，根项目依赖不变。

## 真实模型门禁

预检 `http://localhost:4000/health/liveliness` 连接失败（HTTP 000）；当前进程没有 `LITELLM_RUNTIME_KEY` 或 `LITELLM_MASTER_KEY`。没有读取 `.env` 或打印凭据，没有绕过 LiteLLM 直连 provider，也没有启动生产服务或产生模型费用。

因此真实模型 valid samples 为 0，token、成本、平均/P95 延迟和天气质量均未测量。不能将 fake fixture 时长当作模型性能对比。启用可达的测试 LiteLLM 与受限凭据后，先固定平台模型别名，补齐 Pi 多模态和真实错误/Telemetry 映射，再使用独立数据库执行两引擎配对评测；不足 30 个有效样本只登记 observation-only。

## 复跑与工程依据

```bash
nvm use
npm ci --prefix experiments/pi-agent --ignore-scripts
npm test --prefix experiments/pi-agent
npm test
node .agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs
openspec validate --specs --strict
```

数据结构：`FixtureOptions` 定义引擎、独立数据库、故障场景和策略所有权；HTTP 证据仅为假请求；durable 工具外部效果存于独立文件以暴露 SQLite 事务边界。所有数据均为一次性假资产。

设计模式：Adapter 将 Pi 的可变 transcript 与事件转换到既有 GatewayClient Port；Factory/Dependency Injection 让同一 fixture 驱动两 SDK；durable Worker 使用原生持久 task/registry 而非另写执行引擎。单一职责分别落实到 Adapter、fixture、测试和 Worker；正式 Runtime 无实验依赖，保持依赖倒置和最小实现。

本轮平台回归首次与其他评测并行时为 164/165：既有图片超时测试设置 25 ms Run 预算，负载下模型调用前即耗尽时间，导致预期调用一次、实际零次。单独重跑该用例 1/1，通过后串行重跑全套 165/165；不修改阈值掩盖首次失败。OpenSpec strict 为 1 passed、0 failed；`git diff --check` 通过。100 轮原平台记忆确定性评测 5/5 指标通过，该结果不计作 Pi 记忆能力。

## 重评条件

- 真实业务进入长任务、子 Agent、运行中 checkpoint 或动态扩展，现有组合出现可量化维护损耗。
- Pi durable 提供明确版本兼容与协调方案，能通过单一事实源、跨实例取消及 fencing 验证。
- 同样输入和治理约束下，Pi 减少适配机制并改善真实模型质量、成本或交互效果。

不因本轮测试数量增加就接受迁移。正式实施仍需接受的新决策，以及受影响的 OpenSpec 稳定契约先行。

## 长任务与父子任务追加验证（2026-10-13）

用户要求继续验证能力拆解后的长任务候选。本轮保持 pi 1.2.0、Node 24.19.0 与独立 SQLite，新增 `task-worker.mjs` 和 `test-task-lifecycle.mjs`，没有改动正式 Runtime。新增 5/5，完整 PoC 从历史 46/46 增至 **51/51**。

| 验证窗口 | 观察与断言 | 可以承接的机制 |
| --- | --- | --- |
| 父任务在同一事务创建两个 children、提交 waiting 后进程 exit 77 | 新进程复用原父任务和两个 child ID；父任务创建阶段只一次，两项子任务效果各一次 | 持久 task graph、父子身份与 join 恢复 |
| `allSettled`：一项失败，另一项正常完成 | 两项 receipt 为 failed/completed，父任务获取相同结果 | 等全部任务并保留失败证据 |
| `failFast`：一项失败，另一项处于可取消长等待 | receipt 为 failed/aborted，记录兄弟任务清理 | 失败传播与 owned sibling 中止 |
| 外部调用方中止父任务 | 两项 child 均 aborted，父清理日志最后出现 | bottom-up 取消与清理顺序 |
| 独立 conversation-owned background task 与普通 child 同时存在 | 父取消后 background 仍非 terminal；显式 `root.abort(..., { background: true })` 后才 aborted | 前台/后台取消范围隔离 |

后台任务不是直接 child：1.2.0 实际拒绝 task-owned `background: true`，返回 faulted receipt，消息为 `A child task cannot be background`。测试因此使用 conversation-owned background task，不能将其描述为“直接后台 child 支持”。原生后台子 Agent 应通过 background anchor task 拥有子会话；本轮没有验证该完整子 Agent 模式。取消从外部调用方发起，避免在当前 phase 中等待自身退出造成循环等待。

结合前轮“提交第二阶段 checkpoint 后真实退出，再从第二阶段恢复”的测试，可确认 Pi 已提供可复用的分阶段状态机、持久等待与父子调度机制。这里验证的是长任务所需的状态和取消机制，不是数小时运行、可靠定时器或生产负载稳定性；60 秒 sleep 在测试中被取消，不等待其自然到期。新用例为无模型 custom tasks，不计作真实模型子 Agent 或业务质量评测。

### 更新后的采用判断

| 能力 | 判断 | 仍需平台负责 |
| --- | --- | --- |
| 未来单 owner 的长任务、checkpoint、父子等待/取消 | **优先评估采用 pi-durable，已有原生机制实测证据** | 明确 task 与 Run/Operation 的映射、唯一事实所有者、版本迁移和运行维护责任 |
| 当前只读天气工具恢复 | 继续现基线；没有证据表明替换能减少总体成本 | ToolResult、AcceptanceResult 与当前 API 兼容 |
| 普通文本 Agent loop | Pi 可适配，尚无维护成本净下降证据 | 多模态、结构化输出、Telemetry、错误及网关映射 |
| 多实例执行与外部写操作恢复 | 本轮未通过采用门禁 | RunLease/fencing、跨实例取消、业务幂等、Operation journal、补偿与不确定结果处理 |
| 业务结果可信度 | 不以 Pi terminal/completed 替代业务验收 | Policy 版本、身份、AcceptanceResult、平台模型出口与治理 |

本轮支持的是“避免从零自研通用长任务调度”的候选优先级，不支持现在替换全部平台底座。正式依赖未增加，ADR 仍为提议。缺失定义/版本升级、等待者取消与持久任务取消的区别、原生子 Agent 会话恢复、真实模型质量和长时间压力仍未实测。

工程依据：`Checkpoint` 采用 JSON-safe 阶段与子任务 ID；所有权与 waiting 在 Pi commit 中原子保存。外部文件只作为测试观察，不与 SQLite 形成业务原子性承诺。任务定义采用显式状态机，registry/Harness 通过依赖注入装配；不另写 scheduler。Worker 与断言分离，所有新增函数及回调保留职责注释。

本轮交付检查：平台原回归以 `--test-concurrency=1` 串行执行 **165/165**；OpenSpec strict **1/1**；`git diff --check` 通过。补强父任务 completed receipt 断言后，新增生命周期用例再次 **5/5**。未再次运行 UI 构建或记忆评测，因为本轮没有修改这两条路径；之前的结果保留为历史证据。

# pi Agent Runtime 隔离对比

- 状态：提议
- 日期：2026-10-13
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 模型网关 / 治理与可观测
- 关联需求：判断 pi 是否比继续扩大自研 Runtime 更适合作为底座
- 关联 OpenSpec：不涉及稳定契约；本记录只登记隔离 PoC
- 替代记录：无

## 问题

项目已经通过 AI SDK `ToolLoopAgent` 复用通用模型工具循环，但仍需维护平台级 Session/Run、工具事实、恢复和执行治理。目标是验证 pi 是否能减少通用 Agent Runtime 维护量，同时保持平台事实源和治理边界。

成功证据是：同一模型协议和故障输入下，pi 能通过 Adapter 满足现有工具、取消、重试、恢复、验收和幂等契约，并且长期维护的通用代码明显减少。

## 约束与非目标

### 必须满足

- LiteLLM 仍是唯一模型访问出口。
- SQLite Conversation/Run/ToolResult/AcceptanceResult 仍是平台事实源。
- 工具副作用、重试边界、取消和错误正文脱敏不能由 Agent 引擎绕过。
- PoC 不读取真实密钥、不调用收费模型、不改变正式启动入口。

### 本次不解决

- 真实模型天气质量、图片生成/编辑质量和成本基线。
- pi-durable 的生产稳定性、多实例协调和跨进程锁；后续追加隔离恢复验证，不表示生产验收。
- Sandbox、写操作确认、回读与补偿。

## 候选方案

| 候选 | 路线 | 结论前状态 |
| --- | --- | --- |
| pi-agent-core 1.2.0 | 轻量可组合 Agent 引擎 | 进入隔离对比；需长期维护 Adapter |
| AI SDK Core 7.0.37 `ToolLoopAgent` | 当前轻量组合方案 | 现有主链；无需新增依赖 |
| 最小自研工具循环 | 自研 | 已停止扩展，保留平台事实和治理代码 |

官方证据：pi v1.2.0 的 [Agent Core](https://github.com/earendil-works/pi/tree/v1.2.0/packages/agent)、[pi-durable](https://github.com/earendil-works/pi/tree/v1.2.0/packages/durable) 与 [SDK](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/sdk.md)。`pi-durable` 文档将自身标为 Experimental，并说明单进程存储不提供跨进程锁。

## 关键验证

| 假设 | 验证方法 | 结果 |
| --- | --- | --- |
| pi 可接入现有天气工具和 LiteLLM 协议 | 相同 fake OpenAI-compatible SSE/JSON fixture | 通过 |
| 工具后模型失败不重复 Connector | ToolResult 提交后注入 503，走无工具总结恢复 | 通过；Connector 1 次 |
| 取消、幂等和结果验收保持平台语义 | Runtime 原有 Store/Lease/AcceptanceResult + pi Adapter | 通过 |
| 进程重启恢复不依赖 pi 自身事实源 | 两个 Node 子进程、SQLite、ToolResult checkpoint | 通过 |
| pi 可替代结构化输出路径 | `Output.object` 正反例 | 不采用；仍由现有 GatewayClient 处理 |

可复跑资产：[experiments/pi-agent](../../experiments/pi-agent/README.md)，命令为 `node --test experiments/pi-agent/test-comparison.mjs`。2026-10-13 共 22/22 通过；项目运行时基线已提升为 Node `>=24.0.0`，并在显式 Node 24.19.0 环境完成重跑。Node 20 警告来自上一轮 PoC 目录中的 npm 安装进程，不能据此将直接 node 测试记为 Node 20。

## 当前判断

- 结论：**适配候选，不接受整体迁移**。
- pi 的工具循环和事件模型可以通过小型 Adapter 接入现有 Runtime，PoC 未发现天气、恢复、取消和验收的直接阻断。
- 当前 Pi Adapter 未替代平台 Session/Run、事实存储、ExecutionPolicy、RunLease、ToolResult 或 AcceptanceResult；pi-durable 可提供其他 transcript/task 所有权方案，但整体迁移必须先解决单一事实源，不能直接双写。
- 结构化输出和图片协议仍需现有 GatewayClient，整体替换不能删除该适配层。

## 未采用方案及原因

| 方案 | 原因 | 重评条件 |
| --- | --- | --- |
| 立即整体迁移 pi | PoC 只证明可适配，未证明能删除平台通用机制；pi-durable 仍为 Experimental 且无跨进程锁 | 删除清单显示维护量净减少，并完成多实例/真实模型门禁；Node 24 确定性重跑已通过 |
| 直接采用 pi-durable 作为事实源 | 会与现有 SQLite Conversation/Run/ToolResult 形成双事实源；生产锁与业务验收边界不匹配 | 明确单一数据所有者、迁移/回滚和多实例协调证据 |
| 继续扩大自研循环 | AI SDK 和 pi 均已覆盖通用循环，重复建设没有平台差异化价值 | 两个成熟引擎均无法满足稳定工具/恢复契约 |

## 实施边界

PoC 的 `pi-gateway.mjs` 采用 Adapter 模式：Pi 只负责文本 Agent loop、工具参数校验和事件；平台仍负责模型别名、唯一重试预算、工具执行包装、SQLite 事实、结果验收、幂等和恢复。该 Adapter 不得进入正式装配，除非新决策接受其版本与维护责任。

## 风险与退出路径

- 版本风险：项目统一要求 Node `>=24.0.0`；pi 1.2.0 本身需要 Node `>=22.19.0`，且 `pi-durable` API 标为 Experimental。
- 协议风险：Pi 自有消息类型与当前 AI SDK/平台消息不同，多模态、结构化输出和图片编辑需要额外转换。
- 退出路径：删除 `experiments/pi-agent` 和 Adapter，不迁移正式 SQLite 数据；平台主链不受影响。

## 验收与完成报告

- [x] 功能：22 个固定 fixture 对比用例通过。
- [x] 结构：PoC 沿用平台唯一事实源和 LiteLLM 出口。
- [x] 文档与契约：同步根目录和 PoC 的 engines/lockfile、README、`.nvmrc`、文档索引和 `openspec/project.md` 技术基线；正式业务稳定契约未改变，OpenSpec strict 通过。
- [x] Node 24：显式 Node 24.19.0 下重新安装 PoC 依赖并重跑 22/22；项目 165/165 和 Demo 构建/资源预算通过。
- [ ] 剩余门禁：真实模型、多实例、图片链路、许可与长期维护成本尚未验证。

## Node 24 重跑证据（2026-10-13）

本轮使用 `/Users/Administrator/.nvm/versions/node/v24.19.0/bin/node`，先将对应 `bin` 放入 PATH，再用该 node 执行 npm CLI，确保 npm script 和 Worker 的 `process.execPath` 一致。安装依赖只产生既有 `node-domexception` 弃用提示，没有 EBADENGINE。

| 操作 | 目录 | 实际结果 |
| --- | --- | --- |
| `node -p 'JSON.stringify({version:process.version,execPath:process.execPath})'` | PoC | `v24.19.0`，执行路径为上述 Node 24 |
| `npm ci --ignore-scripts --no-audit --no-fund` | `experiments/pi-agent` | 86 个包按 lockfile 安装成功，无引擎不兼容警告 |
| `npm test` | `experiments/pi-agent` | 22/22，含两套引擎的真实进程退出/恢复 Worker |
| `npm test` | 项目根目录 | 165/165；这是平台原有回归，不计作 Pi 覆盖 |
| `npm run demo:check` | 项目根目录 | 构建通过；gzip JS 364.06 KiB、CSS 7.05 KiB，预算通过 |
| `openspec validate --specs --strict` | 项目根目录 | 1 passed，0 failed |

此次 Node 版本门禁已完成，不意味着 pi-durable、真实模型质量或生产多实例已经通过。运行环境最低版本提高不会改变业务 API、事实所有权或 SDK 选型状态；采用提议仍待后续收益和生产边界验证。

## 后续验证（2026-10-13）

见[完整报告](../audits/2026-10-13-pi-followup-verification.md)。Node 24.19.0 下 PoC 46/46（两引擎对比 40、pi-durable 6）通过；已修复实验 Adapter 的指定模型别名和 HTTP 401 分类问题。视觉适配仍显式拒绝；图片由原 SDK/Responses 委托实现；safe 工具发生崩溃后重放可能重复非幂等外部操作。

新增 Pi 直接依赖均为 MIT，92 个实验 lockfile 包无缺失 license 声明。可替换的 Agent 专属函数约 82 行，实验 Adapter 203 行且尚需补齐视觉/Telemetry，不具备维护成本净下降证据，正式主链继续保留。

本机 LiteLLM 预检不可达且当前进程未配置测试网关凭据，真实有效样本 0；不读取 `.env` 或直连上游补测。生产多实例、写补偿、真实模型质量/成本仍未验收，记录保持提议。

### 长任务候选追加证据

后续原生 task 生命周期新增 5/5，完整 PoC 为 51/51：父子 waiting checkpoint 进程恢复复用身份、allSettled、failFast、bottom-up 取消，以及 conversation-owned background 取消范围通过。结合先前分阶段 checkpoint 恢复，未来单 owner 长任务优先评估 pi-durable，避免重复自研通用 scheduler。1.2.0 不允许直接 task-owned background child；完整原生子 Agent 与数小时稳定性尚未验证。正式采用仍受事实源映射、版本迁移、多实例 fencing、业务幂等与结果验收门禁约束，决策保持提议；详见后续报告追加章节。

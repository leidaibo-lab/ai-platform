# 存量能力选型审计

- 状态：接受
- 日期：2026-07-29
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 连接器与知识层 / 模型网关 / 治理与可观测
- 关联需求：对 V0.6 存量能力补齐成熟方案对比、未采用原因和后续复用边界
- 关联 OpenSpec：本次不改变稳定契约；后续实现按各项结论另行判断并更新 `openspec/specs/ai-platform/spec.md`
- 替代记录：无

## 审计结论

当前项目应继续拥有业务会话事实、Session/Run 契约、上下文选择规则、企业身份与权限边界；模型访问、工具循环、连接协议、遥测采集和长任务持久执行应优先采用成熟生态，不再默认自研。

本次审计不是一次全面替换计划。结论分为四类：

| 结论 | 当前能力 | 后续约束 |
| --- | --- | --- |
| 保留 | LiteLLM + AI SDK + GatewayClient；SQLite 会话事实源；Session/Run 幂等；当前 SSE 交付 | 补齐版本可复现性和重评条件，不因已有代码继续扩大所有权 |
| 封装 | Structured Memory、Context Planner、有限模型重试 | 保留稳定数据和策略，通过 Port/Adapter 给外部实现留出可替换边界 |
| 迁移 | 遥测采集迁移到 OpenTelemetry 语义 | 先做 AI SDK 官方遥测接入 PoC，再选择 Langfuse 或 Phoenix 等后端 |
| 停止扩展 | 自研工具循环、自研 MCP 协议、自研工作流引擎、自研 Trace 查询后端 | 新需求先验证 AI SDK、MCP、LangGraph 或 Temporal，不得直接增加通用框架代码 |

当前先完成 C1 ChainTrace 和其余退出条件，再进入其他场景。ChainTrace 按“决策记录消除冲突 -> AI SDK Telemetry + OpenTelemetry PoC -> 对比 Langfuse/Phoenix -> 接受最终后端决策 -> 正式接入”的顺序推进；AI SDK `ToolLoopAgent` 只读工具 PoC 延后到 C1 退出之后。MCP 仍通过独立的 `@ai-sdk/mcp` 或 MCP 官方 SDK 接入，不在项目内重写协议。

## 审计口径与证据边界

本记录审计的是 2026-07-29 工作区中的 V0.6 切片，使用以下证据：

- `package.json` 固定 `ai@7.0.37` 和 `@ai-sdk/openai-compatible@3.0.14`；两个已安装包均声明 Apache-2.0。
- `docker-compose.yml` 使用 LiteLLM Proxy，当前镜像标签为滚动的 `main-latest`。
- `src/storage/conversation-store.mjs`、`src/runtime/`、`src/resilience/`、`src/gateway/` 和 `src/tools/` 的实际实现。
- `openspec/specs/ai-platform/spec.md` 中已经稳定的 Runtime、GatewayClient、重试、流式和记忆契约。
- 项目自动化测试和上下文记忆确定性评测。
- 候选项目的官方文档、官方仓库或官方协议文档；检索日期为 2026-07-29。

仓库此前没有方案决策记录，因此不能把本次判断包装成当时实现者的历史原意。下文“未采用原因”表示基于当前目标和约束，为什么现在不迁移或不选该候选；无法从代码和文档确认的原始历史原因统一记为“无可追溯证据”。

## 当前能力盘点

| 能力域 | 当前实现 | 外部成熟能力复用 | 审计发现 |
| --- | --- | --- | --- |
| 模型访问 | `GatewayClient` 映射 Runtime 契约、错误和 usage | AI SDK Core、OpenAI-compatible Provider、LiteLLM Proxy | 复用方向正确，但 LiteLLM 使用滚动标签，构建不可完全复现 |
| 会话与 Run | SQLite 保存 Conversation、Message、Run、Event，Runtime 提供幂等和串行边界 | SQLite | 这是平台业务事实和稳定契约，不是通用 Agent 框架的重复实现 |
| 工具执行 | `Tool Registry` 只支持注册、查询和固定的“不启用”结果 | 无 | 真实工具循环尚未实现；此时停止自研成本最低 |
| 记忆 | MemoryDelta、active/superseded、来源 ID、版本和 Episode | 模型结构化输出 | 数据语义有平台价值，但提取、检索和存储后端应允许替换 |
| 上下文 | 高低水位、候选排序、预算装箱、Context Manifest | LiteLLM token counter，可回退本地估算 | 当前规则可解释且有回归，但词法相关性仍是早期实现 |
| 重试 | `RetryExecutor` 统一截止时间、尝试预算、退避和逐尝试证据 | AI SDK 内建重试被关闭，LiteLLM 位于下游 | 适合有界模型调用，不是持久工作流或跨实例恢复引擎 |
| 流式交付 | POST SSE 文本增量和基于事件游标的事实同步 | AI SDK `streamText` | 当前协议已覆盖 Demo；无需为采用 UI 框架而迁移 |
| 观测与评测 | Run/重试证据、Context Manifest、确定性 100 轮 fixture | 无统一 Trace 后端 | 评测基础有价值，但不应继续自建遥测协议和查询平台 |

## 分域决策

### 1. 模型访问与网关

#### 候选

| 候选 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- |
| LiteLLM + AI SDK + GatewayClient | Provider 抽象、OpenAI-compatible 调用、路由、预算、限流、fallback 和流式 | 已在主链中运行；GatewayClient 隔离 Runtime；可私有部署 | 两层都能重试，必须保持唯一尝试预算；当前 LiteLLM 镜像未固定版本 | [LiteLLM 官方文档](https://docs.litellm.ai/docs/)、[AI SDK 官方文档](https://ai-sdk.dev/docs/introduction) |
| Vercel AI Gateway + AI SDK | 托管模型网关、Provider 路由和观测 | 与 AI SDK 集成内聚，平台运维较少 | 会改变自托管、密钥和网关控制面边界；当前没有迁移收益证据 | [Vercel AI Gateway](https://vercel.com/ai-gateway) |
| Runtime 直接调用各 Provider | 模型生成 | 链路最短 | Runtime 重新拥有 Provider 差异、密钥、路由和治理，破坏区域边界 | 当前架构与 OpenSpec |

#### 决策

- 结论：采用并保留现有组合。
- 平台拥有：`GatewayClient` 稳定 Port、Runtime 请求语义、错误映射、身份上下文和唯一重试预算。
- 外部方案负责：AI SDK 负责模型调用抽象；LiteLLM 负责模型网关侧路由、密钥、配额和模型治理。
- 明确不实现：Provider SDK 聚合层、模型网关服务端路由器、另一套业务模型入口。
- 未采用其他方案：当前没有托管网关迁移的合规、成本或能力缺口证据；直接 Provider 调用会丢失现有治理边界。

#### 风险与重评

- 先将 LiteLLM 从 `main-latest` 固定到经过 smoke test 的不可变版本或 digest，记录升级和回退方式。
- LiteLLM 无法满足部署、安全、路由或成本要求，或者 AI SDK Provider 契约无法继续映射现有主链时，重新比较网关候选。

### 2. Agent Runtime 与工具循环

#### 候选

| 候选 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- |
| AI SDK `ToolLoopAgent` + tools | 工具循环、停止条件、审批、流式、Runtime/Tool Context | 当前 `ai@7.0.37` 已实际导出，新增框架和适配最少 | 不直接拥有平台会话事实和跨实例持久恢复 | [AI SDK Agents](https://ai-sdk.dev/docs/agents/overview) |
| LangGraph | 状态图、持久执行、流式、人工介入、长期运行 | 适合复杂分支和可恢复状态图 | 当前 C1 和首个只读工具没有足够复杂度支撑引入第二套运行时 | [LangGraph 官方文档](https://docs.langchain.com/oss/javascript/langgraph/overview) |
| Mastra | TypeScript Agent、Workflow、Memory、RAG、Observability 和 Evals | 相邻能力较内聚 | 会形成平台运行时迁移；部分持久执行能力仍需单独验证成熟度 | [Mastra 官方文档](https://mastra.ai/docs) |
| OpenAI Agents SDK | Agent loop、Session、Guardrail、Handoff、Tracing 和 MCP | 完整度高，官方能力组合紧密 | 当前主链是 LiteLLM 和 Provider-neutral；非 OpenAI 模型需要 Provider/Adapter，并引入第二套 Agent SDK | [OpenAI Agents 指南](https://developers.openai.com/api/docs/guides/agents)、[模型适配](https://developers.openai.com/api/docs/guides/agents/models#providers-and-transport) |
| 自研工具循环 | 仅实现眼前流程 | 能完全贴合内部接口 | 要长期追赶审批、恢复、流式事件、工具错误和上下文协议，不构成平台差异化 | 当前 `src/tools/tool-registry.mjs` |

#### 决策

- 结论：保留 Session/Run 契约；下一阶段适配 AI SDK `ToolLoopAgent`；停止自研通用工具循环。
- 平台拥有：Conversation/Run 事实、身份、授权、审批策略、幂等、ToolResult 审计和渠道协议。
- 外部方案负责：工具调用循环、schema 校验、停止条件和模型工具消息编排。
- 实施边界：先跑通一个无副作用的只读工具；工具执行事件映射回现有 Run，不让 Agent SDK 成为与 Runtime 并列的业务入口。
- 未采用其他方案：LangGraph 和 Temporal 的触发条件尚未出现；Mastra 和 OpenAI Agents SDK 会造成运行时迁移或双 SDK；自研没有差异化收益。

#### 重评

- 出现复杂状态图、动态分支、暂停后恢复或人工介入时，重新评估 LangGraph。
- 出现跨实例、小时级或天级任务、不可重复写副作用、强恢复和补偿要求时，重新评估 Temporal。
- AI SDK 的工具循环无法保留现有 Run 事件、审批和错误契约时，再比较 Mastra、LangGraph 和 OpenAI Agents SDK，不直接回退到自研。

### 3. 工具与连接器协议

#### 候选与决策

AI SDK 官方 MCP 集成使用独立的 `@ai-sdk/mcp` 包；生产建议使用 Streamable HTTP，stdio 只适合本地连接。当前项目未安装该包，`Tool Registry` 也没有真实 MCP 能力，因此架构图里的 MCP 只能视为目标边界，不能报告为已完成。

- 结论：采用 MCP 作为外部工具协议，适配 AI SDK Tool Schema；不自研连接协议。
- 平台拥有：Tool Catalog、企业身份、权限、凭据引用、审批、执行幂等、结果脱敏和审计。
- MCP 负责：能力发现以及 tools、resources、prompts 的标准交换。
- MCP 不负责：Agent 编排、业务授权、任务状态和平台数据所有权。
- 未采用框架专属连接协议：会把连接器锁定到单个 Agent Runtime，且没有比 MCP 更强的跨系统复用证据。
- 证据：[AI SDK MCP](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)、[MCP 架构](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)。

### 4. 结构化记忆与 Context Planner

#### 候选

| 候选 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- |
| 当前 MemoryDelta + Planner | 事实纠正、来源追溯、版本、Episode、预算和 Manifest | 平台拥有数据；行为可解释；现有确定性回归覆盖纠正和实体隔离 | 提取质量依赖模型；相关性仍是轻量词法匹配；真实模型基准尚未建立 | 当前实现、`docs/context-management.md` 和评测 Skill |
| AI SDK Memory Provider 生态 | Letta、Mem0、Supermemory、Hindsight、MongoDB 等记忆后端 | 可复用成熟存储、提取或检索能力 | 可见性、数据模型、锁定和纠正语义因 Provider 而异 | [AI SDK Memory](https://ai-sdk.dev/docs/agents/memory) |
| LangGraph Store/Checkpointer | 图状态、线程 checkpoint 和长期记忆 | 与复杂 LangGraph workflow 内聚 | 仅为记忆引入会同时带入图运行时，不匹配当前架构规模 | [LangGraph 官方文档](https://docs.langchain.com/oss/javascript/langgraph/overview) |
| 全量自研继续扩展 | 提取、向量检索、排序和存储全部自有 | 控制力最高 | 容易演变为独立记忆产品，持续追赶检索、评测和存储生态 | 当前实现边界 |

#### 决策

- 结论：封装并保留当前事实源、MemoryDelta、来源追溯和 Context Manifest；外部 Provider 先基准测试，不直接替换。
- 平台拥有：原始消息、active/superseded 语义、来源 ID、memoryVersion、最终上下文选择证据和数据导出。
- 可外部化：记忆提取、召回、向量索引和候选排序实现。
- 明确不实现：通用向量数据库、面向所有场景的记忆服务、未经基准验证的复杂检索框架。
- 未立即采用 Memory Provider：当前 100 轮 fixture 验证的是确定性链路，不是第三方 Provider 的真实模型质量；直接迁移会先失去可见性和纠正语义，尚无同基准收益证据。

#### 下一项验证与重评

- 基于现有 fixture 增加真实模型 runner，对当前实现和 1 至 2 个候选 Provider 使用相同输入、模型、Prompt、指标和数据驻留约束。
- 同时比较纠正事实准确率、旧事实泄漏率、实体隔离、来源有效率、token、延迟、成本和数据可导出性。
- 候选在质量或总拥有成本上显著更优，并能保留平台事实语义和退出路径时，迁移对应的提取或检索环节，不默认替换全部数据模型。

### 5. 重试与持久执行

#### 候选与决策

| 候选 | 适用边界 | 当前结论 |
| --- | --- | --- |
| 当前 `RetryExecutor` | 单次 Run 内的有界外部调用、共享截止时间、首输出前重试 | 保留，继续作为 Runtime 唯一模型尝试预算 |
| AI SDK / LiteLLM 内建重试 | SDK 或网关局部调用 | 不同时启用，避免多层重试相乘；当前保持 AI SDK `maxRetries: 0` |
| LangGraph Durable Execution | 有状态图的中断、恢复和人工介入 | 到达复杂状态图触发条件后 PoC |
| Temporal | 跨实例长任务、可靠计时、不可重复副作用和补偿 | 当前 C1 不采用；达到长任务和强恢复条件后 PoC |

当前执行器不是工作流引擎。它不得继续扩展为任务调度器、跨实例 lease、持久 timer、补偿框架或通用 checkpoint 系统。[Temporal 官方文档](https://docs.temporal.io/temporal)所描述的 Event History 和故障恢复，应在真实长任务出现时由成熟引擎承担。

### 6. 流式交付

- 结论：保留当前 POST SSE 模型文本流和基于事件游标的会话事实流。
- 采用边界：AI SDK `streamText` 负责模型增量；Runtime 负责 Run 状态、首输出后不重试、最终落库和断线后的最终状态查询。
- 未采用 AI SDK UI Stream：当前渠道是无框架浏览器 Demo，且事实同步和模型文本流有不同恢复语义；迁移不会减少核心复杂度。
- 明确不实现：Token 级 SQLite 持久化、Token 级断点续传、把浏览器状态变成会话事实源。
- 重评条件：出现多个 Web 产品共同使用 AI SDK UI 消息协议，且能保持现有 Run/事件契约时，再评估 Adapter，而不是直接替换 Runtime API。

### 7. 可观测与评测

#### 候选

| 候选 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- |
| AI SDK Telemetry + OpenTelemetry | 模型和工具调用遥测、标准 Trace 导出 | 与现有 AI SDK 集成；后端可替换 | 需要定义身份关联和正文脱敏策略 | [AI SDK Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry) |
| Langfuse | 自托管观测、Prompt、评测和数据集 | AI 场景功能完整，支持 OTel | 需要验证部署、数据保留、权限和升级成本 | [Langfuse Observability](https://langfuse.com/docs/observability/get-started) |
| Phoenix | OpenInference/OTel Tracing、Evals、Datasets 和 Experiments | 开放标准和评测工作流较完整 | 需要验证团队使用流程和长期运维成本 | [Phoenix 官方文档](https://arize.com/docs/phoenix) |
| 自研 Trace 后端 | 自定义事件存储和查询 | 可完全定制 | 查询、采样、留存、脱敏和评测 UI 的维护成本不构成平台差异化 | 当前仅有局部证据字段 |

#### 决策

- 结论：迁移到 OpenTelemetry 语义；Langfuse 与 Phoenix 通过同一 PoC 决定后端；停止自研完整 Trace 存储和查询平台。
- 平台拥有：trace/run/conversation 身份映射、阶段名称、业务指标、采样和脱敏规则。
- 外部方案负责：Span/Metric 导出、存储、查询、可视化和通用评测工作台。
- 保留现有确定性评测作为 Runtime 回归；它不能代表真实模型准确率。
- 未立即确定后端：当前没有部署、安全、查询和总拥有成本的 PoC 证据，直接选定任一后端都属于再次默认执行。

## 未采用方案总表

| 未采用方案 | 当前不采用的原因 | 重新评估触发条件 |
| --- | --- | --- |
| Vercel AI Gateway | 现有 LiteLLM 已满足自托管主链，迁移没有已证实收益 | LiteLLM 出现无法接受的治理、稳定性或成本缺口 |
| OpenAI Agents SDK | 引入第二套 Agent SDK，且当前强调 LiteLLM/provider-neutral | 业务明确以 OpenAI 原生能力为主，Adapter 成本低于现有路径 |
| Mastra 全量迁移 | 会同时替换 Runtime、Memory、Workflow 和观测边界，变更面过大 | 一体化收益经真实 PoC 显著高于组合方案，且持久能力成熟 |
| LangGraph 立即引入 | 当前没有复杂状态图和持久恢复需求 | 出现分支图、HITL、暂停恢复和长步骤编排 |
| Temporal 立即引入 | C1 有界请求不需要独立 Service、Worker 和持久执行运维 | 出现跨实例长任务、可靠 timer、写副作用和强恢复 |
| 外部 Memory Provider 直接替换 | 没有同 fixture 质量、来源、成本和锁定对比 | Provider Benchmark 达标且保留数据所有权和退出路径 |
| AI SDK UI Stream 替换现有 SSE | 不解决当前事实同步和断线语义，收益不足 | 多渠道统一 UI 消息协议成为明确需求 |
| 自研工具循环 / MCP / Trace 后端 | 属于成熟生态已覆盖的通用能力，不是平台差异化 | 原则上不重启；只有硬性边界淘汰全部成熟候选时才立项 |

## 平台自研准入边界

允许平台继续自研的部分：

- 业务身份、租户、权限、审批和审计语义。
- Conversation/Run/Message 的内部稳定契约与数据所有权。
- 工具、模型和记忆外部能力的 Port/Adapter。
- Context Manifest、来源追溯、质量指标和跨能力治理规则。
- 成熟方案无法表达且通过决策记录证明的业务差异。

不得默认自研的部分：

- 通用 Agent 工具循环和模型消息编排。
- MCP 或其他开放协议的客户端、服务端协议栈。
- 通用向量数据库、工作流引擎、分布式任务调度器。
- OpenTelemetry Collector、Trace 存储、查询和可视化平台。
- 已由 LiteLLM 和 AI SDK 覆盖的 Provider 聚合、路由和模型 SDK 适配。

## 实施顺序

| 优先级 | 动作 | 完成证据 | 是否改变当前契约 |
| --- | --- | --- | --- |
| P0 | 完成 C1 ChainTrace OTel PoC，对比 Langfuse/Phoenix 并接受最终后端决策 | 相同 Trace 可导出和检索、敏感正文受控、查询与成本对比、正式接入边界明确 | PoC 否；正式默认启用前复核观测安全边界 |
| P0 | 固定 LiteLLM 版本或 digest | 固定版本、smoke test、升级与回退说明 | 否，若模型行为不变 |
| P1 | 完成 C1 真实模型基线、异常/并发/断连回归和验收阈值 | 满足 `docs/scenario-interaction-chains.md` 的全部 C1 退出条件 | 仅内部评测否；改变稳定行为时需要 OpenSpec |
| P1 | Memory Port 与 Provider Benchmark 设计 | 当前实现和候选使用同 fixture、指标和真实模型 | Port 本身否；替换行为前需要 OpenSpec |
| P2 | C1 退出后执行 AI SDK `ToolLoopAgent` 单一只读工具 PoC | 主路径、工具异常、停止条件、审批边界和 Run 事件映射 | PoC 否；正式开放工具行为前需要 OpenSpec |
| P3 | 达到触发条件后评估 LangGraph/Temporal | 真实中断恢复或副作用用例，不使用 Hello World | 是 |

在 C1 ChainTrace PoC、最终后端决策和其余 C1 退出条件完成前，不横向扩展其他场景实现，也不把候选依赖加入生产主链。

## 风险与退出路径

- 已知风险：LiteLLM 滚动标签不可复现；当前只有确定性记忆评测；没有统一 OTel Trace；Runtime 仅保证单进程同会话串行。
- 锁定点：OpenAI-compatible 消息格式、AI SDK v7 类型和回调、SQLite 数据结构、MemoryDelta 语义。
- 退出路径：GatewayClient 隔离模型 SDK；Conversation Store 保存原始事实；Memory 数据需可导出；OTel 隔离观测后端；MCP 隔离连接器实现。
- 维护责任：平台维护者拥有内部契约、Adapter、评测和升级决策；外部项目自身能力不在本仓复制维护。

## 验收与完成报告

- 验证证据：项目 29 项测试断言全部通过；其中受限环境先通过 28 项，唯一需要监听 `127.0.0.1` 的 SSE 测试在允许本地监听后单独通过 `1/1`。架构边界为 `3/3`，OpenSpec strict 为 `1/1`，Markdown 本地链接检查通过。
- 记忆评测：100 轮确定性 fixture 完成 10 次 checkpoint，纠正事实召回、旧事实隔离、实体隔离、待办召回和来源追溯为 `5/5`、`100.0%`；该结果只证明 Runtime、Reducer、Planner 和判分链路，不代表真实模型准确率。
- 剩余边界：尚未运行真实模型 Memory Provider Benchmark；尚未执行 ToolLoopAgent、OTel 后端和长任务引擎 PoC。
- 文档与契约：本次只补选型治理和存量审计，不改变代理行为、接口、配置或安全边界，因此不修改稳定 OpenSpec。
- 重评条件：进入 V1 真实工具、Runtime 横向扩容、引入有副作用操作、出现小时级任务、记忆质量未达标、观测数据进入生产，或关键依赖发生不兼容升级。

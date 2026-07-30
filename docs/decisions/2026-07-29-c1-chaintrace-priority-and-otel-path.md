# C1 ChainTrace 优先级与 OpenTelemetry 实施路径

- 状态：接受
- 日期：2026-07-29
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 治理与可观测
- 关联需求：在扩展其他场景前完成 C1 ChainTrace，并消除存量审计与 C1 建设焦点之间的优先级冲突
- 关联 OpenSpec：PoC 和内部观测不改变稳定契约；正式默认启用、调整 Session/Run API 或扩大观测数据边界前复核 `openspec/specs/ai-platform/spec.md`
- 替代记录：无；本记录细化 `2026-07-29-existing-capability-selection-audit.md` 的实施顺序

## 问题

`docs/scenario-interaction-chains.md` 将 C1 定义为当前唯一主动建设链路，要求先完成可检索 ChainTrace、真实模型四维基线、异常与并发回归，再扩展其他场景。存量能力选型审计同时把 AI SDK `ToolLoopAgent` 只读工具 PoC 列为 P0、OpenTelemetry PoC 列为 P1，形成了“先完成 C1”与“先进入工具场景 PoC”两种执行顺序。

本记录只解决建设优先级和 ChainTrace 的实施路径。成功证据是：项目存在单一、可执行的顺序，且正式实现前已经明确平台与成熟观测生态的所有权边界。

## 约束与非目标

### 必须满足

- C1 达到退出条件之前，不正式扩展 C2-C7 的场景实现。
- 使用 AI SDK v7 正式 `telemetry` 接口和 OpenTelemetry GenAI 语义，不自研遥测协议。
- 平台只拥有业务身份映射、阶段名称、质量指标、采样和脱敏规则。
- Trace 存储、查询、可视化和通用评测工作台交给成熟后端。
- 敏感输入、输出、附件正文、密钥和原始错误响应默认不进入 Trace。
- PoC、后端选择和正式接入分别保留证据，不把“能导出 Span”直接当作能力完成。

### 本次不解决

- 不选择最终生产 Trace 后端。
- 不新增自研 Trace 数据库、查询 API 或管理页面。
- 不改变现有 Conversation/Run/Message 数据所有权。
- 不进入 ToolLoopAgent、MCP、RAG、写操作或其他场景实现。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| AI SDK Telemetry + OTel + Langfuse | 成熟一体化后端 | GenAI Trace、Prompt、评测、数据集和查询 | AI 场景能力完整，支持 OTel | 需要验证私有部署、数据保留、权限、升级和总成本 | [AI SDK Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)、[Langfuse Observability](https://langfuse.com/docs/observability/get-started) |
| AI SDK Telemetry + OTel + Phoenix | 轻量可组合 | OpenInference/OTel Trace、评测、数据集和实验 | 开放语义和评测工作流完整，后端替换边界清晰 | 需要验证团队查询流程和长期运维成本 | [AI SDK Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)、[Phoenix](https://arize.com/docs/phoenix) |
| SQLite `chain_trace_json` + 自研查询 | 最小自研 | 当前 Run 的阶段字段和本地查询 | 与现有数据库接近 | 需要长期维护采样、留存、查询、脱敏、可视化和评测集成，重复成熟生态能力 | 当前存量能力审计 |

## 淘汰条件

- 无法关闭输入和输出正文采集。
- 无法通过 `requestId + conversationId + runId` 关联一次 C1 Run。
- 需要改变 Runtime 主链或把观测后端变成同步调用单点。
- 无法私有部署或无法满足后续数据驻留、权限和审计要求。
- 使用私有 Trace 协议导致后端不可替换。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| AI SDK v7 可输出 OTel GenAI Span | 使用 `ai@7.0.37`、`@ai-sdk/otel` 和 `InMemorySpanExporter` 执行 JSON/SSE Run | 固定 fake LiteLLM 与 C1 fixture | 通过：JSON/SSE 均产生 `invoke_agent`、`step`、`chat` GenAI Span，并归入 `c1.conversation.run` | `scripts/test-chain-trace.mjs` |
| 敏感正文可以完全关闭 | 设置 `recordInputs: false`、`recordOutputs: false`，对官方错误事件增加脱敏适配并扫描导出 Span | 文本、回答、图片 data URL、文档 URL 和错误响应样例 | 通过：上述敏感样例均未出现在 Span 名称、属性、状态或事件中 | `scripts/test-chain-trace.mjs` |
| 同一 Trace 可进入两个候选后端 | 使用同一 OTLP 数据分别接入 Langfuse 和 Phoenix | 相同 Trace fixture 和部署环境 | 待验证 | 后续后端对比记录 |
| 重试不会拆成多个业务 Trace | 构造首次失败、第二次成功的模型调用 | 现有最多三次模型尝试策略 | 通过：两次 AI SDK 模型调用具有不同 `attempt`，但共享同一个 OTel `trace_id` 和业务 Chain ID | `scripts/test-chain-trace.mjs` |

## OTel PoC 结果

- 状态：通过自动化 PoC，尚未进入候选后端对比和生产接入。
- Span 树：`c1.conversation.run` 覆盖排队、Run 起始落库、Context Planner、可选记忆压缩、AI SDK GenAI Span、Run 完成或失败落库，以及 JSON/SSE 最终交付。
- 查询字段：根 Span 以及 Run ID 已知后的 Runtime/模型 Span 均携带 `requestId`、`conversationId`、`runId`、业务 Chain ID 和 `scenarioId=C1`；OTel 原生 `trace_id` 保持标准语义。
- Token：Context Planner 只在内部 Span 记录 system、current input、memory、episodes、history 和 total input 分段，不扩大公开 Context Manifest。
- 幂等：重放请求产生新的 OTel 请求 Trace，但沿用原 Run 的业务 Chain ID，且不再次创建模型 Span。
- 默认边界：`OTEL_ENABLED=false`；禁用时使用 Null Object，不初始化 SDK、Exporter 或 AI SDK Telemetry，不改变现有 Session/Run API。
- 验证命令：`npm run test:telemetry`，4/4 通过。
- 下一门禁：使用同一 OTLP Trace fixture 分别接入 Langfuse 和 Phoenix，比较部署、安全、权限、查询、保留和成本；形成新的接受记录前不宣布 ChainTrace 正式完成。

## 决策

- 结论：适配。
- 选择方案：先使用 AI SDK Telemetry + OpenTelemetry 完成 C1 PoC，再用同一组 Trace 对比 Langfuse 和 Phoenix；最终后端通过新的接受记录确定。
- 决策依据：OpenTelemetry 保留标准语义和后端替换能力，AI SDK 已能提供模型调用、首段输出和 Token 等 GenAI Span，平台只需补 C1 业务阶段和身份映射。
- 平台拥有：C1 Span 树、业务关联字段、分阶段耗时、分段 Token、错误分类、采样和脱敏规则。
- 外部方案负责：OpenTelemetry SDK/Exporter、Trace 存储、查询、可视化和通用评测工作台。
- 明确不实现：自研 Trace 后端、SQLite Trace 副本、通用查询语言和观测管理页面。

本记录接受的是 C1 优先级和 OTel PoC 路径，不代表 Langfuse 或 Phoenix 已被接受为生产后端。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| 直接确定 Langfuse | 尚无部署、安全、权限和总拥有成本对比证据 | PoC 证明其在硬约束和整体成本上优于 Phoenix |
| 直接确定 Phoenix | 尚无团队查询流程和长期运维证据 | PoC 证明其在硬约束和整体成本上优于 Langfuse |
| SQLite Trace + 自研查询 | 重复建设通用观测基础设施，不符合复用治理 | 仅当所有成熟候选都被硬性安全或部署边界淘汰时重新立项 |

## 实施边界

建设顺序固定为：

```text
决策记录消除优先级冲突
  -> AI SDK Telemetry + OpenTelemetry PoC
  -> 使用同一 Trace 对比 Langfuse 与 Phoenix
  -> 新建并接受最终后端决策记录
  -> 正式接入并完成 C1 ChainTrace 验收
  -> 完成其余 C1 退出条件
  -> 再进入其他场景
```

PoC 默认关闭且不得进入生产主链。正式接入仍通过 Agent Runtime 产生业务关联语义，观测导出保持旁路；观测后端不可写入 Conversation、Run、Message 或 Memory 事实数据。

## 风险与退出路径

- 已知风险：AI SDK v7 telemetry integration 和 OTel GenAI 语义仍可能随版本变化；后端对同一属性的索引和展示能力可能不同。
- 锁定点：AI SDK v7 lifecycle、OpenTelemetry GenAI Semantic Conventions 和 OTLP 协议。
- 退出路径：保留内部 ChainTracer Port 和 OTel 属性语义，更换后端时只替换 exporter 或部署配置。
- 维护责任：平台维护者负责业务 Span 语义、隐私规则、测试和依赖升级；外部后端自身的存储与查询能力不在仓库内复制。

## 验收与完成报告

- 验证证据：JSON/SSE 主路径、重试、失败、幂等重放、断连和正文脱敏测试；可检索 Trace；分阶段耗时与分段 Token；两个后端的部署、安全、查询和成本对比。
- 剩余边界：最终后端、采样率、保留期、权限模型和生产部署方式待 PoC 后决策。
- 文档与契约：本记录和优先级调整不修改 OpenSpec；正式默认启用或扩大 API/安全边界时同步稳定规范。
- 重评条件：AI SDK/OTel 不再满足隐私或关联要求、两个候选均不满足私有部署硬约束，或生产规模要求独立治理服务。

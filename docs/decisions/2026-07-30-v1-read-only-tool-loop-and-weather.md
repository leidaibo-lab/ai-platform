# V1 只读工具循环与天气 Connector

- 状态：接受
- 日期：2026-07-30
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 连接器与知识层 / 模型网关 / 治理与可观测
- 关联需求：以用户在 C1 渠道查询实时天气为入口，跑通第一个可追溯、无副作用的 C4 只读工具闭环
- 关联 OpenSpec：`openspec/specs/ai-platform/spec.md`
- 前置记录：`2026-07-29-existing-capability-selection-audit.md`
- 后续记录：`2026-07-31-ai-sdk-core-v7-alignment.md` 细化本记录中的 `ToolLoopAgent` 复用、动态调用配置和 Core 特殊路径，其余天气 Connector 与安全边界继续有效

## 问题与边界

当前 Conversation、Run、Context Planner、GatewayClient、SSE、取消、重试和 ChainTrace 已经存在，但 `Tool Registry` 仍固定返回不启用，GatewayClient 不发送工具定义，Runtime 也不保存 ToolResult。用户询问实时天气时，模型只能基于已有知识拒答或给出查询建议。

本次目标是在不改变 Runtime 业务入口和 SQLite 事实所有权的前提下，以天气查询验证一次完整的 `模型选择工具 -> Runtime 校验与执行 -> ToolResult 回填 -> 最终回答`。非目标包括 MCP 服务治理、企业业务数据、任意网页访问、动态代码、写操作、人工确认和跨实例恢复。

## 候选与证据

### 工具循环

| 候选 | 结论 | 依据 |
| --- | --- | --- |
| AI SDK `ToolLoopAgent` | 适配 | 当前已锁定 `ai@7.0.37`，原生提供工具 schema、执行、停止条件、流式和回调；与现有 GatewayClient 的 SDK 路径最内聚 |
| LangGraph / Mastra / OpenAI Agents SDK | 暂不采用 | 当前只有单一有界只读工具，没有状态图、第二套 Runtime 或运行时迁移收益 |
| 自研循环 | 不采用 | 需要长期追赶工具消息编排、校验、停止、审批和错误语义，不构成平台差异化 |

### 天气数据源

| 候选 | 结论 | 依据 |
| --- | --- | --- |
| Open-Meteo Geocoding + Forecast API | 采用 | 无服务端密钥；固定 HTTPS API；返回地点、时区、当前观测、日预报和单位；2026-07-30 已用广东深圳真实请求验证响应 |
| 和风天气等带密钥商业 API | 暂不采用 | 中国区域能力更完整，但当前 Demo 需要新增凭据、配额和商业条款，尚无对应生产要求 |
| 通用 Web Search | 不采用为首个工具 | 返回结构不稳定，还需来源筛选、提示注入和网页内容治理，无法隔离验证最小 ToolResult 闭环 |

官方证据：[AI SDK Agents](https://ai-sdk.dev/docs/agents/overview)、[Open-Meteo Weather API](https://open-meteo.com/en/docs)、[Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api)。

## 决策

- 固定 LiteLLM 为本机已验证的不可变镜像 `ghcr.io/berriai/litellm@sha256:89ccaccfda9083f7693777597ca27f8ffca12045e4fa9277155fb7c5f06e68b2`；升级时先拉取新候选、运行模型 smoke test 和 Runtime 回归，再显式更新 digest。回退只需恢复上一 digest。
- 适配 AI SDK `ToolLoopAgent`，在 GatewayClient 生命周期内复用同一个工具型对话 Agent，通过 call options 按 Run 动态选择模型、工具和步骤预算，最大四个模型步骤；不自研通用循环。动态结构化输出等特殊调用继续使用 Core 函数，具体分流由 `2026-07-31-ai-sdk-core-v7-alignment.md` 固化。
- 对包含明确地点且处于今天或明天范围的天气输入，由服务端 Tool Registry 进行确定性任务路由：首步使用 AI SDK `toolChoice` 强制 `get_weather`，ToolResult 回填后恢复 `auto`。真实模型在纯 `auto` 下可能直接回答，因此不能只依赖 Prompt 或模型自觉。
- 平台拥有 Run、工具 allowlist、权限、ToolResult、幂等、SSE 事件和审计；AI SDK 负责模型工具消息编排；Open-Meteo Connector 只负责固定端点的地点解析和天气读取；LiteLLM 不执行工具。
- 首个工具固定为 `get_weather`，只接受地点和 `today` / `tomorrow`，不得接受 URL、代码或任意请求参数。
- Connector 失败以安全结构化 ToolResult 回填模型；用户取消继续终止整个 Run。
- 实时天气只属于当前 Run 工具事实，不进入长期结构化记忆。

## 验收证据

- 主路径：深圳今日或明日天气返回结构化温度、天气现象、降水、风速、数据时间和来源，并由模型形成最终回答。
- 异常路径：地点不存在、输入非法、超时和上游错误均产生确定状态；原始响应和调用栈不进入渠道或 Trace。
- 稳定性：已完成 Run 的幂等重放不再次调用天气服务；工具循环最多四步并共享 Run 截止时间。
- 可观测：工具执行进入 SQLite 事实事件、POST SSE 和脱敏 ChainTrace Span。
- 回归：Connector、Registry、GatewayClient、Runtime、SSE Adapter 和渠道阶段确定性测试通过；真实模型 smoke test 单独报告。

## 剩余边界与重评

- Open-Meteo 的可用性、许可、数据驻留或中国区域质量不能满足正式业务要求时，重新比较和风天气或企业自有天气源。
- 出现跨系统复用的多个 Connector 后，再通过 `@ai-sdk/mcp` 的 Streamable HTTP PoC 评估 MCP；不在本仓自研协议。
- 出现有副作用工具时进入 C6，先补权限、预览、人工确认、业务幂等和结果回读，不复用本次只读默认策略。
- 出现复杂分支、暂停恢复或跨实例长任务时，再分别重评 LangGraph 与 Temporal。

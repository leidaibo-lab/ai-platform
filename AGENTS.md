# AGENTS.md

本文件是当前项目的 AI 协作入口。项目事实以代码、`README.md`、`docs/` 和 `openspec/` 为准；如果它们不一致，先通过文件检索确认，再做最小范围修正。

## 输出与协作

- 默认使用中文回复。
- 开始任务前先看当前文件状态和相关入口：`README.md`、`config.yaml`、`scripts/`、`demo/`、`docs/`、`openspec/`、`.agents/skills/`。
- 如果目录是 Git 仓库，先用 `git status --short`、`git diff --stat`、`git diff --name-only` 检索关键变更信息；当前目录不是 Git 仓库时，用 `find`/`rg --files` 说明依据。
- 不读取、打印或提交 `.env` 中的真实密钥；示例值放在 `.env.example`。
- 提交信息遵守 `type(scope): message`。
- 提交标题和必要说明以中文描述为主，例如 `docs(ai-platform): 补充架构边界与服务拆分说明`。

## 项目定位

当前项目总称为“AI 应用基础平台”，定位为面向不同业务场景、按需组合和逐步拆分 AI 能力的基础平台。整体分为渠道与体验层、平台控制面、Agent Runtime、连接器与知识层、模型网关、治理与可观测六个区域；只有模型访问、路由、密钥和模型调用治理属于严格意义上的 AI Gateway。

当前项目、仓库和目录统一使用 `ai-platform`；拆出的模型网关服务使用 `model-gateway`。模型网关仍是平台内部区域，不得用 `ai-platform` 代替模型网关领域名称。

当前代码以 V0.6 会话与上下文基线为主体，并落地 V1 首个只读工具切片：浏览器多会话 Demo、SQLite 会话事实源、幂等 Run、结构化记忆、Context Planner、token 高低水位、LiteLLM 调用封装、AI SDK Core 有界多步工具调用与 `Output.object` 结构化输出、Open-Meteo 天气 Connector、ToolResult 事实、completed 只读 ToolResult 后的受限进程重启恢复、天气 AcceptanceResult、默认关闭的 C1 ChainTrace OpenTelemetry 旁路与已选定的 Phoenix 后端，以及 OpenSpec/docs/回归评测的最小治理。普通 C1 当前为 R2/A0，天气确定性路由切片为受限 R3/A3，C2 图片生成开发切片为 R2/A2；正式实例、真实 Runtime Trace、真实模型天气质量、多实例协调和完整 C4 业务数据能力当前仍是触发式 TODO 或未完成边界，不得写成已完成运行态能力。未来大平台属于平台控制面和渠道调用方，不得把页面、会话、工具循环、RAG 或业务流程继续塞进模型网关。

区域之间遵守单向依赖：渠道调用 Agent Runtime；Runtime 调用连接器和模型网关；平台控制面发布版本化 Agent、工具和模型策略；治理与可观测通过统一身份上下文和事件结构横切各区域。当前先保持单仓，出现跨项目复用、独立安全边界、独立扩缩容或团队所有权后，再按数据所有权拆成服务。

所有业务模型请求统一经过 Agent Runtime；GatewayClient、AI SDK 和 LiteLLM 只作为 Runtime 下游模型调用链，不得形成与 Runtime 并列的业务入口。

全局业务主链：

```text
浏览器 Demo / 未来渠道
        -> Demo Server 渠道 HTTP Adapter
        -> Agent Runtime
        -> GatewayClient
        -> AI SDK Core + @ai-sdk/openai-compatible
        -> LiteLLM Proxy
        -> 上游 OpenAI-compatible API
```

模型连通性测试链：

```text
scripts/test-chat.sh -> LiteLLM Proxy -> 上游 OpenAI-compatible API
```

模型连通性测试链仅用于本地 smoke test、CI 和排障，不属于全局能力规划、业务入口、普通客户端接入方式或服务拆分依赖。新增或更新全局架构图、能力清单、服务蓝图和演进路线时不得把该测试链画入业务主链。

## 文档路由

- `README.md`：面向使用者的启动、Runtime 配置和模型连通性测试说明。
- `docs/README.md`：项目文档索引。
- `docs/ai-structure.md`：六个架构区域、控制面/数据面、依赖规则、数据所有权、服务拆分边界和演进路线。
- `docs/ai-sdk-core-alignment.md`：AI SDK Core v7 当前采用、兼容、延后和不采用的 API 边界。
- `docs/runtime-reliability-and-acceptance.md`：R0-R4 执行可靠性、A0-A4 结果可信度、当前场景定位和扩展模板。
- `docs/scenario-interaction-chains.md`：定义共同底座与场景能力边界，按输入场景拆分业务链路；当前聚焦 C1 功能可用和确定性回归，ChainTrace 运行态验收按触发条件恢复。
- `docs/solution-selection-governance.md`：方案发现、成熟能力复用、`采用 / 适配 / 自研` 决策门禁、完成定义和存量能力审计规则。
- `docs/decisions/`：保存可追溯的方案决策记录；新记录从 `docs/decisions/TEMPLATE.md` 创建，保留采用理由、未采用理由和重评条件。
- `docs/coding-standards.md`：函数注释、数据结构、设计模式和设计原则等编码规范。
- `.agents/skills/README.md`：Agent Skill 索引和目录治理规则。
- `.agents/skills/docs/context-memory-evaluation/SKILL.md`：上下文记忆评测场景、指标、脚本和回归治理流程。
- `openspec/project.md`：项目级区域边界、依赖规则和技术约定。
- `openspec/specs/ai-platform/spec.md`：稳定能力契约。修改代理行为、Session/Run API、鉴权方式、模型别名、结构化记忆、上下文预算或密钥边界时，需要同步这里。

## 方案选型与复用

- 项目默认遵守“成熟方案采用优先，其次基于成熟方案适配，最后才是自研”，平台价值优先放在选型、组合、边界适配、治理和统一出口，不以重复实现通用基础能力作为建设成果。
- 新增平台能力、跨模块公共能力、重要外部依赖或自研通用机制前，必须先阅读 `docs/solution-selection-governance.md`，并在 `docs/decisions/` 新建方案决策记录。
- 方案发现至少覆盖成熟一体化方案、轻量可组合方案和最小自研方案；确实不足三类时，必须在记录中说明检索范围和缺失原因，不能把首先想到的实现当作默认方案。
- 决策必须回答当前问题、约束和非目标，列出候选方案、验证证据、最终选择、未采用原因、自研边界、维护责任、退出路径和重评条件。只列功能清单不算完成选型。
- 未完成方案决策前不得进入正式实现。允许建立有时间边界的调研或 PoC，但 PoC 只能用于验证关键假设，不得直接宣称能力完成或自然演变为生产实现。
- 只有涉及核心差异化、数据或安全边界无法满足、成熟方案适配成本高于自研总成本，或者能力足够小且边界稳定时，才允许自研；记录中必须给出证据和长期维护责任。
- 既有实现如果缺少方案决策记录，统一视为“待补选型证据”，不因已经运行而自动视为合理，也不在未评估迁移成本前直接替换。
- 能力交付不得只报告“已完成”。变更说明至少包含能力目标、调研候选、最终选择、未采用原因、自研范围、验证证据、剩余边界和重评条件。
- 方案决策不能替代 OpenSpec。最终选择如果改变稳定接口、配置、安全或行为边界，仍需先更新 OpenSpec，再进入实现。

## 编码规范

- 所有函数都必须有紧邻的注释，覆盖命名函数、类方法、构造函数、箭头函数和回调函数；注释至少说明职责，必要时补充参数、返回值、副作用和异常。
- 导出函数、公共方法和复杂函数使用 JSDoc；简单内部函数也必须有简短职责注释。注释解释意图和边界，不复述代码语法。
- 实现前明确核心数据结构、字段约束、可空性、所有权和可变性；跨模块数据优先用 JSDoc `@typedef` 或同等结构化方式描述。
- 根据真实问题选择设计模式，并在模块注释或设计文档中说明模式名称、参与角色和解决的问题；简单逻辑可以不引入设计模式，禁止为了满足形式而过度设计。
- 代码遵守单一职责、高内聚低耦合、依赖倒置，以及 KISS、DRY、YAGNI；外部 I/O、输入校验和核心逻辑保持清晰边界。
- 交付前按 `docs/coding-standards.md` 检查本次变更涉及的全部函数，并在变更说明中给出数据结构、设计模式和设计原则的具体依据。

## Skill 规则

- 所有 Skill 只放在 `.agents/skills/`。
- Skill 目录遵守 `https://gitlab.seakoi.net/seakoi/skills` 仓库的指南、要求、原则。
- 本地目录采用两级结构：`.agents/skills/<顶级目录>/<技能目录>/SKILL.md`。
- `SKILL.md` 的 `name` 必须等于 `<顶级目录>-<技能目录>`。
- `metadata.pattern` 必须说明主设计模式，建议值为 `tool-wrapper`、`generator`、`reviewer`、`inversion`、`pipeline`。
- 新增、更新、删除 Skill 时，同步更新 `.agents/skills/README.md`。
- 修改 Skill 后运行 `node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs`。
- 不创建 `.cursor/`、`.trae/`、`.qoder/`、`.vscode/` 或根目录 `skills/` 平行目录。

## OpenSpec 规则

- 新需求或行为变更先判断是否影响稳定契约；影响时补 OpenSpec，再改实现。
- 只改文案、说明、局部样式且不改变接口/配置/安全边界时，可以只更新 docs 或 README。
- 验证优先级：`openspec validate --specs --strict`、相关脚本 smoke test、必要时再启动 Demo 验证。

## 当前关键文件

- `config.yaml`：LiteLLM Proxy 的模型别名、上游转发参数和 master key 配置。
- `docker-compose.yml`：本地 LiteLLM 容器启动入口。
- `docker-compose.chaintrace.yml`：触发 ChainTrace TODO 后使用的后端入口，固定 Phoenix 19.10.0 digest、PostgreSQL 17、Auth、30 天保留并禁用匿名 telemetry；当前日常启动不要求运行。
- `scripts/test-chat.sh`：仅用于验证 LiteLLM 到上游模型连通性的最小 smoke test，不属于平台业务入口。
- `scripts/test-architecture-boundaries.mjs`：全局架构图与治理契约的边界回归检查，防止模型诊断链重新进入平台能力规划。
- `scripts/demo-server.mjs`：当前集成式渠道 HTTP Adapter 和本地装配入口，负责会话资源、JSON Run、POST SSE 模型文本流、会话事件流、静态页面和错误返回。
- `demo/index.html`：浏览器多会话交互页面。浏览器只提交当前输入和幂等标识，通过 POST SSE 增量渲染模型文本，不保存会话事实源，也不直接接触上游真实 key。
- `src/config/env.mjs`：Demo Server、runtime 和 gateway client 的配置加载入口。
- `src/storage/conversation-store.mjs`：SQLite 会话事实源，负责会话、消息、Run、ToolResult、AcceptanceResult、MemoryDelta、版本和事件日志。
- `src/runtime/chat-runtime.mjs`：Session/Run 应用服务，负责先落消息、上下文规划、确定性工具开放、模型调用、受限重启恢复、结果验收、文本交付、最终结果落库、幂等重放和关闭会话。
- `src/runtime/result-acceptance.mjs`：独立结果验收 Registry；当前天气策略根据持久化 ToolResult 检查地点、数据时间、来源和结果事实。
- `src/runtime/context-planner.mjs`：按优先级和 token 预算选择 active 记忆、相关 Episode 与最近消息，并输出 Context Manifest。
- `src/runtime/memory-manager.mjs`：结构化记忆提取、高低水位压缩、MemoryDelta 校验和 memoryVersion 乐观锁。
- `src/runtime/conversation-coordinator.mjs`：按 conversationId 串行同一进程内的 Run。
- `src/resilience/retry-executor.mjs`：共同底座的统一重试执行器和 `ResilienceContext`，负责共享截止时间、局部尝试、退避和逐尝试证据。
- `src/observability/chain-tracer.mjs`：Runtime 依赖的后端中立 `ChainTracer` Port，负责 C1 阶段 Span、业务标识和错误脱敏语义。
- `src/observability/otel-runtime.mjs`：OpenTelemetry Facade，负责默认关闭、OTLP/HTTP protobuf exporter、采样、AI SDK Telemetry 和进程生命周期。
- `src/gateway/gateway-contract.mjs`：Runtime 依赖的 GatewayClient 数据契约和统一错误类型。
- `src/gateway/gateway-client.mjs`：唯一模型生成客户端，使用 AI SDK Core 的 `generateText` / `streamText`、`tools + stopWhen + prepareStep` 和 `Output.object`，通过 `@ai-sdk/openai-compatible` 调用 LiteLLM，并保持 Runtime 的 chat completions 契约。
- `src/gateway/litellm-management-client.mjs`：LiteLLM 专属管理客户端，仅封装 `/v1/models` 和 token counter，不负责模型生成。
- `src/tools/tool-registry.mjs`：连接器与知识层的服务端只读工具 allowlist，并把平台工具定义适配为 AI SDK ToolSet。
- `src/tools/weather-tool.mjs`：当前首个 `get_weather` 只读工具定义，收敛输入 schema 与公开错误。
- `src/connectors/open-meteo-weather.mjs`：固定访问 Open-Meteo HTTPS 端点的天气 Adapter，返回稳定 `weather.v1` ToolResult。
- `.agents/skills/company-public/skill-governance/SKILL.md`：Skill 创建、更新、迁移和校验规范。
- `.agents/skills/company-public/skill-governance/scripts/validate-skills.mjs`：Skill 目录与 frontmatter 校验脚本。
- `.agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs`：100 轮上下文记忆确定性评测入口。
- `.agents/skills/docs/context-memory-evaluation/assets/fixtures/`：上下文记忆评测的对话事件、标准答案和指标数据。
- `src/evaluation/`、`scenarios/runtime/`：固定行为模型、进程故障注入、真实模型模式和独立场景验收的共用 Runner 与版本化资产。

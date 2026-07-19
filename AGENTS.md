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

当前代码落地这个目标结构里的 V0.6 切片：浏览器多会话 Demo、SQLite 会话事实源、幂等 Run、结构化记忆、Context Planner、token 高低水位、LiteLLM 调用封装、连接器注册预留，以及 OpenSpec/docs/回归评测的最小治理。未来大平台属于平台控制面和渠道调用方，不得把页面、会话、工具循环、RAG 或业务流程继续塞进模型网关。

区域之间遵守单向依赖：渠道调用 Agent Runtime；Runtime 调用连接器和模型网关；平台控制面发布版本化 Agent、工具和模型策略；治理与可观测通过统一身份上下文和事件结构横切各区域。当前先保持单仓，出现跨项目复用、独立安全边界、独立扩缩容或团队所有权后，再按数据所有权拆成服务。

核心链路：

```text
客户端 / 内部脚本
        |
        | base_url = http://localhost:4000/v1
        | api_key = LITELLM_MASTER_KEY
        v
LiteLLM Proxy
        |
        | UPSTREAM_API_BASE + UPSTREAM_API_KEY
        v
上游 OpenAI-compatible API
```

浏览器 Demo 的链路是：

```text
浏览器 Demo
        |
        | /api/runtime/conversations/{conversationId}/runs
        v
Demo Server 渠道 HTTP Adapter
        |
        v
Runtime 上下文与消息构造
        |
        v
LiteLLM Proxy -> 上游 OpenAI-compatible API
```

## 文档路由

- `README.md`：面向使用者的启动、测试、客户端配置说明。
- `docs/README.md`：项目文档索引。
- `docs/ai-structure.md`：六个架构区域、控制面/数据面、依赖规则、数据所有权、服务拆分边界和演进路线。
- `docs/coding-standards.md`：函数注释、数据结构、设计模式和设计原则等编码规范。
- `.agents/skills/README.md`：Agent Skill 索引和目录治理规则。
- `.agents/skills/docs/context-memory-evaluation/SKILL.md`：上下文记忆评测场景、指标、脚本和回归治理流程。
- `openspec/project.md`：项目级区域边界、依赖规则和技术约定。
- `openspec/specs/ai-platform/spec.md`：稳定能力契约。修改代理行为、Session/Run API、鉴权方式、模型别名、结构化记忆、上下文预算或密钥边界时，需要同步这里。

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
- `scripts/test-chat.sh`：最小 chat completions smoke test。
- `scripts/demo-server.mjs`：当前集成式渠道 HTTP Adapter 和本地装配入口，负责会话资源、Run、SSE、静态页面、JSON 收发和错误返回。
- `demo/index.html`：浏览器多会话交互页面。浏览器只提交当前输入和幂等标识，不保存会话事实源，也不直接接触上游真实 key。
- `src/config/env.mjs`：Demo Server、runtime 和 gateway client 的配置加载入口。
- `src/storage/conversation-store.mjs`：SQLite 会话事实源，负责会话、消息、Run、MemoryDelta、版本和事件日志。
- `src/runtime/chat-runtime.mjs`：Session/Run 应用服务，负责先落消息、上下文规划、模型调用、幂等重放和关闭会话。
- `src/runtime/context-planner.mjs`：按优先级和 token 预算选择 active 记忆、相关 Episode 与最近消息，并输出 Context Manifest。
- `src/runtime/memory-manager.mjs`：结构化记忆提取、高低水位压缩、MemoryDelta 校验和 memoryVersion 乐观锁。
- `src/runtime/conversation-coordinator.mjs`：按 conversationId 串行同一进程内的 Run。
- `src/gateway/litellm-client.mjs`：Agent Runtime 到模型网关的客户端边界，封装 LiteLLM `/v1/models` 和 `/v1/chat/completions` 调用。
- `src/tools/tool-registry.mjs`：连接器与知识层的工具注册和工具意图判断预留入口，当前不启用真实工具循环。
- `.agents/skills/company-public/skill-governance/SKILL.md`：Skill 创建、更新、迁移和校验规范。
- `.agents/skills/company-public/skill-governance/scripts/validate-skills.mjs`：Skill 目录与 frontmatter 校验脚本。
- `.agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs`：100 轮上下文记忆确定性评测入口。
- `.agents/skills/docs/context-memory-evaluation/assets/fixtures/`：上下文记忆评测的对话事件、标准答案和指标数据。

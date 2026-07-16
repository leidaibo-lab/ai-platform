# AGENTS.md

本文件是当前项目的 AI 协作入口。项目事实以代码、`README.md`、`docs/` 和 `openspec/` 为准；如果它们不一致，先通过文件检索确认，再做最小范围修正。

## 输出与协作

- 默认使用中文回复。
- 开始任务前先看当前文件状态和相关入口：`README.md`、`config.yaml`、`scripts/`、`demo/`、`docs/`、`openspec/`、`.agents/skills/`。
- 如果目录是 Git 仓库，先用 `git status --short`、`git diff --stat`、`git diff --name-only` 检索关键变更信息；当前目录不是 Git 仓库时，用 `find`/`rg --files` 说明依据。
- 不读取、打印或提交 `.env` 中的真实密钥；示例值放在 `.env.example`。
- 提交信息遵守 `type(scope): message`。
- 提交标题和必要说明以中文描述为主，例如 `docs(ai-gateway): 补充 skills 规范与校验脚本`。

## 项目定位

当前项目重新定义为按五个父级能力逐步演进的轻量 AI Gateway。它以 LiteLLM Proxy 作为模型网关底座，把上游 OpenAI-compatible 中转站密钥收在服务端，并在此之上逐步补齐接入层、智能体/工作流运行层、工具注册与连接器层、模型网关层、治理与运营层。

当前代码只落地这个目标结构里的轻量切片：浏览器 Demo 和客户端接入、Demo Runtime、LiteLLM 调用封装、上下文预算与摘要记忆、工具注册预留，以及 OpenSpec/docs/smoke test 的最小治理。不要把 MCP、RAG、预算、审计等能力拆成新的顶层；它们应分别挂在工具连接、知识接入、模型治理或运营治理父级下。

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
        | /api/runtime/chat
        v
Demo Server 接入层
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
- `docs/ai-structure.md`：AI 调用链路、模块分层、配置边界和演进路线。
- `docs/coding-standards.md`：函数注释、数据结构、设计模式和设计原则等编码规范。
- `.agents/skills/README.md`：Agent Skill 索引和目录治理规则。
- `openspec/project.md`：项目级约定和技术边界。
- `openspec/specs/ai-gateway/spec.md`：稳定能力契约。修改代理行为、Demo API、鉴权方式、模型别名、上下文预算或密钥边界时，需要同步这里。

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
- `scripts/demo-server.mjs`：本地 Demo Server 接入层，负责静态页面、分层 API 路由、JSON 收发和错误返回。
- `demo/index.html`：浏览器交互页面。浏览器只调用 Demo Server，不直接接触上游真实 key。
- `src/config/env.mjs`：Demo Server、runtime 和 gateway client 的配置加载入口。
- `src/runtime/`：聊天运行、摘要压缩、上下文预算、消息构造和输入校验。
- `src/gateway/litellm-client.mjs`：LiteLLM `/v1/models` 和 `/v1/chat/completions` 调用封装。
- `src/tools/tool-registry.mjs`：工具注册和工具意图判断预留入口，当前不启用真实工具循环。
- `.agents/skills/company-public/skill-governance/SKILL.md`：Skill 创建、更新、迁移和校验规范。
- `.agents/skills/company-public/skill-governance/scripts/validate-skills.mjs`：Skill 目录与 frontmatter 校验脚本。

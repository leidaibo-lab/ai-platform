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

当前项目是轻量 AI Gateway 试用版，用 LiteLLM Proxy 把上游 OpenAI-compatible 中转站密钥收在服务端，并对外暴露统一的 OpenAI-compatible 入口。

核心链路：

```text
客户端 / Demo / 内部脚本
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

## 文档路由

- `README.md`：面向使用者的启动、测试、客户端配置说明。
- `docs/README.md`：项目文档索引。
- `docs/ai-structure.md`：AI 调用链路、模块分层、配置边界和演进路线。
- `.agents/skills/README.md`：Agent Skill 索引和目录治理规则。
- `openspec/project.md`：项目级约定和技术边界。
- `openspec/specs/ai-gateway/spec.md`：稳定能力契约。修改代理行为、Demo API、鉴权方式、模型别名、上下文预算或密钥边界时，需要同步这里。

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
- `scripts/demo-server.mjs`：本地 Demo Server，负责读取服务端环境变量、调用 LiteLLM、状态检查、摘要压缩和上下文预算裁剪。
- `demo/index.html`：浏览器交互页面。浏览器只调用 Demo Server，不直接接触上游真实 key。
- `.agents/skills/company-public/skill-governance/SKILL.md`：Skill 创建、更新、迁移和校验规范。
- `.agents/skills/company-public/skill-governance/scripts/validate-skills.mjs`：Skill 目录与 frontmatter 校验脚本。

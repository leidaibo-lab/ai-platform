# Project Guidelines

## Purpose

项目总称为“AI 应用基础平台”，项目、仓库和目录统一使用 `ai-platform`，面向不同业务场景按需组合渠道、Agent Runtime、连接器、知识、模型网关和治理能力。当前实现使用 LiteLLM Proxy 收口上游 OpenAI-compatible 中转站 key，并向本地客户端、脚本和 Demo 提供模型入口与轻量 Agent Runtime。

项目区域为：

- 渠道与体验层：Demo、Web、IM、IDE 和 API Adapter，只负责入口协议与展示适配。
- 平台控制面：租户、用户、应用、Agent 定义、版本发布和策略配置；未来正式平台归入此区域。
- Agent Runtime：会话、上下文、任务路由、工具循环、结果组装和人工确认。
- 连接器与知识层：工具执行、MCP、业务 API、搜索/网页、文档解析、RAG 和知识权限。
- 模型网关：LiteLLM、模型别名、provider key、virtual key、多模型路由、fallback、预算和限流。
- 治理与可观测：身份上下文、审计事件、调用追踪、评测、反馈和安全策略。

只有模型访问、模型路由、模型密钥和模型调用治理属于严格意义上的 AI Gateway。拆出的模型网关服务使用 `model-gateway`；项目改名不改变稳定 API 行为。当前版本只声明已落地的 Demo、Runtime 雏形、模型网关和连接器注册预留，不把平台控制面、真实工具、知识库、多人治理或运营能力写成稳定可用能力。

## Technology

- LiteLLM Proxy 容器镜像：`ghcr.io/berriai/litellm:main-latest`
- Docker Compose 本地启动
- Node.js 原生 HTTP Demo Server 与内置 SQLite 会话存储
- AI SDK Core v7 与 `@ai-sdk/openai-compatible` Runtime 模型网关客户端
- 静态 HTML Demo UI
- Shell smoke test

## Conventions

- 默认中文文档和中文协作。
- 提交信息遵守 `type(scope): message`。
- 真实密钥只放 `.env`，示例值放 `.env.example`。
- 客户端只感知模型别名和 gateway endpoint，不直接感知上游真实模型、base url 或 key。
- 行为契约变更需要同步 `openspec/specs/ai-platform/spec.md`。

## Architecture

```text
纯模型客户端
  -> 模型网关 LiteLLM Proxy
  -> 上游 OpenAI-compatible API

Demo / 未来平台 / 渠道 Adapter
  -> Agent Runtime
      -> 连接器与知识层
      -> 模型网关 LiteLLM Proxy
  -> 最终结果或人工确认状态

平台控制面
  -> 发布版本化 AgentDefinition / ToolPolicy / ModelPolicy

所有区域
  -> 统一治理与可观测事件
```

Demo 浏览器页面不直接调用 LiteLLM 或上游中转站，而是通过 `scripts/demo-server.mjs` 的渠道 HTTP Adapter 和 `src/runtime/` 代理，以保证服务端密钥不出现在浏览器里。未来正式平台与 Demo 并存，通过稳定 Runtime 契约复用同一执行能力。

## Constraints

- 当前落地保持模块化单体和本地 SQLite，不默认引入后台管理或分布式服务。
- 六个区域同时作为概念、代码和未来服务拆分边界；未实现的区域能力不得写成当前稳定能力。
- 区域依赖保持为“渠道 -> Agent Runtime -> 连接器/模型网关”；平台控制面只发布版本化配置，治理与可观测通过统一事件和策略横切。
- 模型网关不得保存会话、工具结果或业务知识；Agent Runtime 和平台控制面不得持有 provider key；渠道特有字段不得渗透到 Runtime 核心结构。
- 服务拆分以数据所有权、跨项目复用、独立安全边界、独立扩缩容或团队所有权为触发条件，不按目录数量机械拆分。
- 每类事实数据只能有一个写入所有者；拆服务前先明确 API、事件和数据迁移边界，禁止多个服务共同写同一张表。
- 不把 `.env` 中的真实值写入文档、OpenSpec 或日志说明。
- 修改代理行为、鉴权、模型路由、Demo API、上下文预算或多模态输入契约时，先更新 OpenSpec 或同步补齐 OpenSpec。
- 当前 `openspec/specs/ai-platform/spec.md` 描述 V0.6 持久化会话与结构化上下文切片；真正拆出服务时再按模型网关、Agent Runtime、连接器和平台控制面分别建立稳定 spec。
- 若目录不是 Git 仓库，最终说明需要明确“无法通过 git diff 检索变更”，改用文件扫描和本次编辑清单说明。

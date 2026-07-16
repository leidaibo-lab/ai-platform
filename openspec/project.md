# Project Guidelines

## Purpose

`ai-gateway` 是一个按五个父级能力逐步演进的轻量 AI Gateway 项目。当前实现以 LiteLLM Proxy 作为模型网关底座，把上游 OpenAI-compatible 中转站 key 收在服务端，并向本地客户端、脚本和 Demo 暴露统一入口。

项目父级能力为：

- 接入层：Demo、客户端、内部脚本，后续扩展到业务系统、IM、IDE 和 API。
- 智能体/工作流运行层：聊天运行、上下文预算、摘要记忆，后续扩展到任务理解、工具循环和人工确认。
- 工具注册与连接器层：当前预留工具注册边界，后续接入 MCP、业务 API、搜索/网页、文档和知识库连接器。
- 模型网关层：LiteLLM、模型别名、provider key 收口，后续扩展到 virtual key、多模型路由、fallback 和成本策略。
- 治理与运营层：当前依靠 OpenSpec、README、docs 和 smoke test 做最小治理，后续补身份、权限、预算、限流、审计、评测和安全护栏。

当前版本只声明已落地的轻量切片，不把规划中的工具、知识库、多人治理或运营平台能力写成稳定可用能力。

## Technology

- LiteLLM Proxy 容器镜像：`ghcr.io/berriai/litellm:main-latest`
- Docker Compose 本地启动
- Node.js 原生 HTTP Demo Server
- 静态 HTML Demo UI
- Shell smoke test

## Conventions

- 默认中文文档和中文协作。
- 提交信息遵守 `type(scope): message`。
- 真实密钥只放 `.env`，示例值放 `.env.example`。
- 客户端只感知模型别名和 gateway endpoint，不直接感知上游真实模型、base url 或 key。
- 行为契约变更需要同步 `openspec/specs/ai-gateway/spec.md`。

## Architecture

```text
客户端 / 内部脚本
        |
        | OpenAI-compatible request
        v
LiteLLM Proxy
        |
        | OpenAI-compatible upstream request
        v
上游中转站

浏览器 Demo
        |
        | Demo Server 分层 API
        v
Runtime 上下文与消息构造
        |
        v
LiteLLM Proxy
```

Demo 浏览器页面不直接调用 LiteLLM 或上游中转站，而是通过 `scripts/demo-server.mjs` 的接入层和 `src/runtime/` 代理，以保证服务端密钥不出现在浏览器里。

## Constraints

- 当前落地保持轻量试用切片，不默认引入数据库和后台管理。
- 父级能力可以作为规划边界，但未实现的子项不得写成当前稳定能力。
- 不把 `.env` 中的真实值写入文档、OpenSpec 或日志说明。
- 修改代理行为、鉴权、模型路由、Demo API、上下文预算或多模态输入契约时，先更新 OpenSpec 或同步补齐 OpenSpec。
- 若目录不是 Git 仓库，最终说明需要明确“无法通过 git diff 检索变更”，改用文件扫描和本次编辑清单说明。

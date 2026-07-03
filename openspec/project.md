# Project Guidelines

## Purpose

`ai-gateway` 是一个轻量 LiteLLM Proxy 项目，用于把上游 OpenAI-compatible 中转站 key 收在服务端，并向本地客户端、脚本和 Demo 暴露统一的 OpenAI-compatible 入口。

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
客户端 / Demo / 内部脚本
        |
        | OpenAI-compatible request
        v
LiteLLM Proxy
        |
        | OpenAI-compatible upstream request
        v
上游中转站
```

Demo 浏览器页面不直接调用 LiteLLM 或上游中转站，而是通过 `scripts/demo-server.mjs` 代理，以保证服务端密钥不出现在浏览器里。

## Constraints

- 当前项目保持最小试用版，不默认引入数据库和后台管理。
- 不把 `.env` 中的真实值写入文档、OpenSpec 或日志说明。
- 修改代理行为、鉴权、模型路由、Demo API、上下文预算或多模态输入契约时，先更新 OpenSpec 或同步补齐 OpenSpec。
- 若目录不是 Git 仓库，最终说明需要明确“无法通过 git diff 检索变更”，改用文件扫描和本次编辑清单说明。


# ai-gateway

一个按五个父级能力逐步演进的轻量 AI Gateway 项目。当前实现以 LiteLLM Proxy 作为模型网关底座，把上游 OpenAI-compatible 中转站 key 收在服务端，并对本地客户端、脚本和 Demo 暴露统一入口。

## 项目定义

`ai-gateway` 不是单纯的 LiteLLM Proxy 包装，也不是一次性建设完整智能体平台。它的项目边界按父级能力组织：

1. 接入层：承接浏览器 Demo、客户端、内部脚本，后续扩展到业务系统、IM、IDE 和 API。
2. 智能体/工作流运行层：承接聊天运行、上下文预算、摘要记忆，后续扩展到任务理解、工具循环和人工确认。
3. 工具注册与连接器层：先预留工具注册边界，后续接入 MCP、业务 API、搜索/网页、文档和知识库连接器。
4. 模型网关层：当前由 LiteLLM 负责模型别名、上游转发和 key 收口，后续扩展到 virtual key、多模型路由、fallback 和成本策略。
5. 治理与运营层：当前由 OpenSpec、README、docs 和 smoke test 做最小治理，后续补身份、权限、预算、限流、审计、评测和安全护栏。

当前代码只落地这个目标结构里的轻量切片：接入层、Runtime 雏形、模型网关调用封装和工具注册预留。未实现的父级子项只作为规划边界，不在当前版本声明为可用能力。

## 适用场景

- 小范围内部试用 AI Gateway 的模型入口、Demo 接入和上下文处理能力。
- 先验证上游中转站能否被统一代理，再逐步增加工具、知识和治理能力。
- 客户端只使用统一 base url、访问 key 和模型别名，不接触上游真实 key。
- 暂时不引入云厂商 AI Gateway、管理后台或数据库。
- 后续需要多人 key、预算、限流和统计时，再升级 LiteLLM virtual key、数据库和治理层能力。

## 当前工作方式

```text
客户端 / Cursor / 内部脚本
        |
        | base_url = http://localhost:4000/v1
        | api_key = LITELLM_MASTER_KEY
        v
LiteLLM Proxy
        |
        | UPSTREAM_API_BASE + UPSTREAM_API_KEY
        v
你的中转站 OpenAI-compatible API
```

浏览器 Demo 不直接调用上游中转站；它只请求本地 Demo Server，由 Demo Server 使用服务端环境变量访问 LiteLLM。

## 本地启动

复制环境变量模板：

```bash
cp .env.example .env
```

修改 `.env`：

```bash
UPSTREAM_API_BASE=https://你的中转站地址/v1
UPSTREAM_API_KEY=你的中转站真实key
LITELLM_MASTER_KEY=换成你自己的本地访问key
```

再确认 `config.yaml` 里的模型映射：

```yaml
model_name: chat-default
model: openai/你的模型名
```

`chat-default` 是客户端使用的模型别名；`model` 是上游真实模型名，请改成你的中转站实际支持的模型。当前仓库配置以 `config.yaml` 为准。

启动：

```bash
docker compose up -d
```

如果当前机器没有 `docker compose`，可以直接用 Docker 启动：

```bash
docker run -d --name ai-gateway-litellm \
  --env-file .env \
  -p 4000:4000 \
  -v "$PWD/config.yaml:/app/config.yaml:ro" \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml --port 4000
```

查看日志：

```bash
docker compose logs -f litellm
```

Docker 直启方式查看日志：

```bash
docker logs -f ai-gateway-litellm
```

## 验证

运行 smoke test：

```bash
source .env
bash scripts/test-chat.sh
```

或者直接 curl：

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chat-default",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

## 客户端接入

如果客户端支持 OpenAI-compatible 配置：

```text
Base URL: http://localhost:4000/v1
API Key: 你的 LITELLM_MASTER_KEY
Model: chat-default
```

## 交互 Demo

启动本地 Demo 页面：

```bash
node scripts/demo-server.mjs
```

浏览器打开：

```text
http://localhost:4010
```

页面会请求本地 Demo Server，再由 Demo Server 使用 `.env` 里的 `LITELLM_MASTER_KEY` 调用 `http://localhost:4000/v1/chat/completions`。浏览器不会拿到 `UPSTREAM_API_KEY`。

Demo 输入区支持：

- 正文：直接输入问题或指令。
- 图片：可以上传本地图片，也可以粘贴图片 URL；Demo Server 会按 OpenAI-compatible 的 `image_url` 多模态格式转发。
- 文档链接：可以粘贴一个或多个链接，Demo Server 会把它们作为文本上下文附在用户消息里。
- 上下文：浏览器会保存最近几轮用户/助手消息，并在下一次请求里随 `messages` 一起传给模型；侧边栏可以看到当前上下文条数，也可以清空上下文。
- 摘要记忆：历史消息超过近期窗口后，Demo 会调用 `/api/runtime/summaries` 把旧对话压缩成摘要；后续请求按“摘要 + 最近消息 + 当前消息”发送。
- Token 预算：Demo Server 会按 `DEMO_MAX_CONTEXT_TOKENS` 做兜底裁剪，优先保留当前消息、摘要和最近历史，超预算的旧消息不会发送给模型。

注意：LiteLLM Proxy 只负责转发请求，不会自动打开文档链接、读取私有文档，也不会自动提取文档里的图片。如果要让模型处理文档里的图片，需要把图片单独上传，或提供可公开访问的图片直链，并确保当前上游模型支持视觉输入。

Demo Server API 按层级暴露：

| API | 说明 |
| --- | --- |
| `GET /api/gateway/status` | 检查 LiteLLM 连接状态、gateway base url 和模型别名 |
| `POST /api/runtime/chat` | 发送当前消息、图片、文档链接、摘要和历史，返回助手回复 |
| `POST /api/runtime/summaries` | 将旧历史压缩成后续请求可复用的摘要 |

## 配置与密钥

- `chat-default` 是对外暴露的模型别名，客户端只需要知道这个名字。
- `model_list[].litellm_params.model` 是 LiteLLM 转发给中转站的真实模型名。中转站是 OpenAI-compatible 时，通常保留 `openai/` 前缀。
- `UPSTREAM_API_BASE` 通常要带 `/v1`。
- `UPSTREAM_API_KEY` 是中转站真实 key，只应放在服务端 `.env`。
- `LITELLM_MASTER_KEY` 是 LiteLLM 当前对外访问 key，部署前请改成强随机值。

## 文档与规范

| 信息 | 放置位置 |
| --- | --- |
| 启动、验证、客户端接入 | `README.md` |
| AI 协作规则、文档路由、提交规范 | `AGENTS.md` |
| Agent Skill 索引、目录规范、治理规则 | `.agents/skills/README.md` |
| 调用链路、模块分层、配置边界、演进路线 | `docs/ai-structure.md` |
| 函数注释、数据结构、设计模式和设计原则 | `docs/coding-standards.md` |
| 项目级技术约定 | `openspec/project.md` |
| 代理行为、Demo API、鉴权、模型别名、上下文预算等稳定契约 | `openspec/specs/ai-gateway/spec.md` |

Skill 相关内容统一放在 `.agents/skills/`，并遵守 `https://gitlab.seakoi.net/seakoi/skills` 仓库的指南、要求、原则。修改 Skill 后可运行 `node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs` 校验目录与 frontmatter。修改代理行为、Demo API、鉴权、模型别名或上下文预算时，需要同步 OpenSpec；只调整启动说明、示例命令或文案时，通常更新 README 或 docs 即可。

## 后续升级方向

当前项目按父级能力演进，不把所有功能点平铺成同一层：

1. 接入层：从 Demo 扩到业务系统、IM、内部工具。
2. 智能体/工作流运行层：补任务理解、工具调用循环、上下文记忆和人工确认。
3. 工具注册与连接器层：补 MCP、搜索/网页、业务 API、文档和知识库连接器。
4. 模型网关层：从单模型别名扩到 virtual key、多模型路由和 fallback。
5. 治理与运营层：补身份权限、预算限流、审计日志、观测评测和安全护栏。

架构总图、规划图和 V0.5-V4 实施对比见 `docs/ai-structure.md`。

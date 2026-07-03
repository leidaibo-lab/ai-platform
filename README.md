# ai-gateway

一个轻量 LiteLLM Proxy 项目，用来把上游 OpenAI-compatible 中转站 key 收在服务端，并对本地客户端、脚本和 Demo 暴露统一的 OpenAI-compatible 接口。

## 适用场景

- 小范围内部试用 AI Gateway 能力。
- 先验证上游中转站能否被统一代理。
- 客户端只使用统一 base url、访问 key 和模型别名。
- 暂时不引入云厂商 AI Gateway、管理后台或数据库。
- 后续需要多人 key、预算、限流和统计时，再升级 LiteLLM virtual key 与数据库。

## 工作方式

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
- 摘要记忆：历史消息超过近期窗口后，Demo 会调用 `/api/summarize` 把旧对话压缩成摘要；后续请求按“摘要 + 最近消息 + 当前消息”发送。
- Token 预算：Demo Server 会按 `DEMO_MAX_CONTEXT_TOKENS` 做兜底裁剪，优先保留当前消息、摘要和最近历史，超预算的旧消息不会发送给模型。

注意：LiteLLM Proxy 只负责转发请求，不会自动打开文档链接、读取私有文档，也不会自动提取文档里的图片。如果要让模型处理文档里的图片，需要把图片单独上传，或提供可公开访问的图片直链，并确保当前上游模型支持视觉输入。

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
| 项目级技术约定 | `openspec/project.md` |
| 代理行为、Demo API、鉴权、模型别名、上下文预算等稳定契约 | `openspec/specs/ai-gateway/spec.md` |

Skill 相关内容统一放在 `.agents/skills/`，并遵守 `https://gitlab.seakoi.net/seakoi/skills` 仓库的指南、要求、原则。修改 Skill 后可运行 `node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs` 校验目录与 frontmatter。修改代理行为、Demo API、鉴权、模型别名或上下文预算时，需要同步 OpenSpec；只调整启动说明、示例命令或文案时，通常更新 README 或 docs 即可。

## 后续升级方向

当前项目是最小试用版，没有引入数据库。等你需要下面能力时，再接 Postgres：

- 给不同人发 virtual key
- 按人、团队、模型做预算
- 按 key 做限流
- 查看更细的使用统计
- 多中转站或多模型 fallback

到那一步，可以继续基于这个项目加 `DATABASE_URL`、Postgres 服务和 LiteLLM virtual key 管理接口。

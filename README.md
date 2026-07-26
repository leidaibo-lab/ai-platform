# AI 应用基础平台

面向不同业务场景，按需组合渠道、Agent Runtime、连接器、知识、模型网关和治理能力的 AI 应用基础平台。当前实现使用 LiteLLM Proxy 收口上游 OpenAI-compatible 中转站 key，并提供带持久化会话、结构化记忆和上下文规划的本地 Agent Runtime。

## 项目定义

AI 应用基础平台不是单纯的 LiteLLM Proxy 包装，也不把所有后端能力都统称为 AI Gateway。整体按六个可独立复用和部署的区域组织：

1. 渠道与体验层：Demo、Web、IM、IDE 和 API Adapter。
2. 平台控制面：租户、用户、应用、Agent 定义、版本发布和策略配置。
3. Agent Runtime：会话、上下文、任务路由、工具循环、结果组装和人工确认。
4. 连接器与知识层：MCP、业务 API、搜索/网页、文档解析、RAG 和知识权限。
5. 模型网关：LiteLLM、模型别名、provider key、virtual key、路由、fallback、预算和限流。
6. 治理与可观测：身份上下文、审计、调用追踪、评测、反馈和安全策略。

严格意义上的 AI Gateway 只指第 5 个区域。项目、仓库和目录统一使用 `ai-platform`；拆出的模型网关服务使用 `model-gateway`。当前代码落地的是开发 Demo、Agent Runtime 雏形及其 GatewayClient、LiteLLM 模型网关和连接器注册预留；未来正式平台作为新的控制面和渠道调用方接入，不替换 Runtime、连接器或模型网关。

## 适用场景

- 小范围内部试用模型网关、Demo 接入和 Agent Runtime 的上下文处理能力。
- 先验证上游中转站能否被统一代理，再逐步增加工具、知识和治理能力。
- Runtime 只使用统一 base url、访问 key 和模型别名，不接触上游真实 key。
- 使用 Node.js 内置 SQLite 保存本地会话，不引入外部数据库或管理后台。
- 后续需要多人 key、预算、限流和统计时，再升级 LiteLLM virtual key、数据库和治理层能力。

## 当前工作方式

```text
浏览器 Demo / 未来渠道
  -> Demo Server 渠道 HTTP Adapter
  -> Agent Runtime
  -> GatewayClient
  -> AI SDK Core + @ai-sdk/openai-compatible
  -> LiteLLM Proxy
  -> 上游 OpenAI-compatible API
```

浏览器 Demo 不直接调用 LiteLLM 或上游中转站；它只请求本地 Demo Server，由 Agent Runtime 通过统一 GatewayClient 访问模型网关。

`scripts/test-chat.sh -> LiteLLM -> 上游模型` 仅用于检查模型连通性和排障，不属于全局业务链路、平台能力规划或客户端接入方式。

## 本地启动

本地需要 Node.js 22.5 或更高版本，以使用内置 `node:sqlite`。

安装 Demo Server 和 AI SDK Gateway Client 的锁定依赖：

```bash
npm ci
```

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

`chat-default` 是 Runtime GatewayClient 使用的逻辑模型别名；`scripts/test-chat.sh` 仅在连通性诊断时复用该别名。`model` 是上游真实模型名，请改成你的中转站实际支持的模型。当前仓库配置以 `config.yaml` 为准。

启动：

```bash
docker compose up -d
```

如果当前机器没有 `docker compose`，可以直接用 Docker 启动：

```bash
docker run -d --name ai-platform-model-gateway \
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
docker logs -f ai-platform-model-gateway
```

## 模型连通性验证

以下命令仅验证 LiteLLM、模型配置和上游是否正常，不代表平台业务调用方式。

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

## Runtime 模型网关配置

Agent Runtime 和模型连通性测试使用以下服务端配置：

```text
Base URL: http://localhost:4000/v1
API Key: 你的 LITELLM_MASTER_KEY
Model: chat-default
```

这些配置不用于浏览器或普通业务客户端直连；业务请求统一通过 Agent Runtime API 进入平台。

## 交互 Demo

启动本地 Demo 页面：

```bash
npm run demo
```

浏览器打开：

```text
http://localhost:4010
```

页面会请求本地 Demo Server，再由 Demo Server 装配的 Agent Runtime 通过 GatewayClient 和 AI SDK，使用 `.env` 里的 `LITELLM_MASTER_KEY` 调用 LiteLLM。浏览器不会拿到 `LITELLM_MASTER_KEY` 或 `UPSTREAM_API_KEY`。

Runtime 的唯一模型生成实现使用 AI SDK Core 和 `@ai-sdk/openai-compatible`，调用同一个 LiteLLM 地址、模型别名和访问 key。它不会使用 `@ai-sdk/vercel` 直连 v0，也不会绕过模型网关；LiteLLM 专属的模型状态和 token counter 由独立管理客户端访问。

Demo 输入区支持：

- 正文：直接输入问题或指令。
- 图片：可以上传本地图片，也可以粘贴图片 URL；Demo Server 会按 OpenAI-compatible 的 `image_url` 多模态格式转发。
- 文档链接：可以粘贴一个或多个链接，Demo Server 会把它们作为文本上下文附在用户消息里。
- 多会话：Runtime 使用 SQLite 持久化会话和完整原始消息；刷新页面、切换标签页后仍能继续会话。
- 多端同步：同一会话通过 SSE 事件游标增量刷新；客户端不再保存或提交历史事实源。
- 结构化记忆：Memory Manager 提取目标、约束、偏好、事实、决策、任务和 Episode，用户纠正会废弃旧事实并保留来源消息。
- Context Planner：按系统规则、当前输入、active 记忆、相关 Episode、最近消息的优先级装箱，并返回可解释 Context Manifest。
- Token 水位：动态原始消息达到 75% 高水位后压缩到 45% 低水位；接近 90% 硬水位时先同步压缩再回答。

注意：LiteLLM Proxy 只负责转发请求，不会自动打开文档链接、读取私有文档，也不会自动提取文档里的图片。如果要让模型处理文档里的图片，需要把图片单独上传，或提供可公开访问的图片直链，并确保当前上游模型支持视觉输入。

Demo Server API 按层级暴露：

| API | 说明 |
| --- | --- |
| `GET /api/gateway/status` | 检查 LiteLLM 连接状态、gateway base url 和模型别名 |
| `GET /api/runtime/conversations` | 列出持久化会话 |
| `POST /api/runtime/conversations` | 创建会话 |
| `GET /api/runtime/conversations/{id}` | 查询完整消息、结构化记忆和版本状态 |
| `POST /api/runtime/conversations/{id}/runs` | 发送当前输入并执行幂等 Run |
| `POST /api/runtime/conversations/{id}/close` | 完成最终 checkpoint 并结束会话 |
| `GET /api/runtime/conversations/{id}/events` | 订阅多端增量事件流 |

Run 请求只包含当前输入和幂等标识：

```json
{
  "requestId": "request-uuid",
  "clientMessageId": "message-uuid",
  "message": "当前问题",
  "imageUrls": [],
  "documentUrls": []
}
```

## Runtime 验证

运行 Gateway Client 协议兼容、会话、幂等、结构化记忆、乐观锁、关闭会话和架构边界回归：

```bash
npm test
```

只检查全局架构边界：

```bash
npm run test:architecture
```

运行 100 轮长期记忆评测：

```bash
node .agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs
```

评测会在第 45 轮把当前项目消息队列从 RabbitMQ 更正为 Kafka，并验证 100 轮后仍能正确回答，同时隔离另一个仍使用 RabbitMQ 的项目。

默认场景保存在 `.agents/skills/docs/context-memory-evaluation/assets/fixtures/message-queue-correction-100.json`。新增评测场景只增加 fixture，并通过 `--fixture <path>` 传给通用 runner，不修改脚本判分逻辑。

## 配置与密钥

- `chat-default` 是 Runtime GatewayClient 使用的逻辑模型别名；模型连通性诊断复用该别名，浏览器和普通业务客户端不直接使用。
- `model_list[].litellm_params.model` 是 LiteLLM 转发给中转站的真实模型名。中转站是 OpenAI-compatible 时，通常保留 `openai/` 前缀。
- `UPSTREAM_API_BASE` 通常要带 `/v1`。
- `UPSTREAM_API_KEY` 是中转站真实 key，只应放在服务端 `.env`。
- `LITELLM_MASTER_KEY` 是 Runtime 和模型连通性诊断访问内部模型网关的服务端凭据，不提供给浏览器或普通业务客户端；部署前请改成强随机值。
- `LITELLM_BASE_URL` 是 Runtime 使用的 LiteLLM Proxy 根地址，默认 `http://localhost:4000`，不要追加 `/v1`。
- `LITELLM_MODEL` 是 Runtime 请求的 LiteLLM 模型别名，默认 `chat-default`。
- `DEMO_DATABASE_PATH` 是 Runtime SQLite 文件，默认 `.data/ai-platform.sqlite`。
- `DEMO_CONTEXT_HIGH_WATERMARK_RATIO`、`DEMO_CONTEXT_LOW_WATERMARK_RATIO` 和 `DEMO_CONTEXT_HARD_WATERMARK_RATIO` 控制压缩水位。

## 文档与规范

| 信息 | 放置位置 |
| --- | --- |
| 启动、Runtime 配置、Demo 使用和模型连通性验证 | `README.md` |
| AI 协作规则、文档路由、提交规范 | `AGENTS.md` |
| Agent Skill 索引、目录规范、治理规则 | `.agents/skills/README.md` |
| 调用链路、模块分层、配置边界、演进路线 | `docs/ai-structure.md` |
| 会话、结构化记忆、上下文规划、并发和评测 | `docs/context-management.md` |
| 函数注释、数据结构、设计模式和设计原则 | `docs/coding-standards.md` |
| 项目级技术约定 | `openspec/project.md` |
| 平台当前集成切片、Demo API、鉴权、模型别名、上下文预算等稳定契约 | `openspec/specs/ai-platform/spec.md` |

Skill 相关内容统一放在 `.agents/skills/`，并遵守 `https://gitlab.seakoi.net/seakoi/skills` 仓库的指南、要求、原则。修改 Skill 后可运行 `node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs` 校验目录与 frontmatter。修改代理行为、Demo API、鉴权、模型别名或上下文预算时，需要同步 OpenSpec；只调整启动说明、示例命令或文案时，通常更新 README 或 docs 即可。

## 后续升级方向

当前保持单仓和轻量部署，先稳定区域接口，再按跨项目复用、独立安全边界、独立扩缩容或团队所有权逐个拆成服务：

1. V1：补 Agent Runtime 的任务路由、工具循环、失败兜底和人工确认，并跑通一个真实连接器。
2. V2：把 LiteLLM 模型网关补成团队共享服务，增加 virtual key、多模型路由、fallback、预算、限流和调用统计。
3. V3：按资源和权限边界拆出连接器服务与知识服务。
4. V4：建设平台控制面和多渠道 Adapter，复用已经稳定的 Runtime、连接器和模型网关。
5. 治理与可观测贯穿所有阶段，通过统一身份上下文和事件结构接入，不成为同步调用单点。

区域定义、依赖规则、数据所有权、服务拆分条件和 V0.5-V4 实施对比见 `docs/ai-structure.md`。

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

严格意义上的 AI Gateway 只指第 5 个区域。项目、仓库和目录统一使用 `ai-platform`；拆出的模型网关服务使用 `model-gateway`。当前代码落地的是开发 Demo、Agent Runtime 及其 GatewayClient、LiteLLM 模型网关，以及首个有界只读天气工具闭环；未来正式平台作为新的控制面和渠道调用方接入，不替换 Runtime、连接器或模型网关。

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

当前交付以 C1 对话问答为基线，并以 Open-Meteo 跑通首个只读天气工具，同时增加 C2 文生图的首个开发切片：显式图片操作、独立图片模型别名、生成结果校验、本地图片资产、幂等重放、取消和 JSON/SSE 交付已经通过 fake 回归，并用 `gpt-image-2` 跑通一次真实模型 happy-path smoke。该单样本只证明当前 LiteLLM、AI SDK 与上游组合可生成并落存图片，不代表内容审核、精确尺寸、成本、取消/超时/错误或生产可用性已经验收；正式对象存储和图片理解资产输入也尚未完成。ChainTrace 的代码、稳定契约、Phoenix 选型和部署入口已经保留但默认关闭；具体边界见[场景化输入到大模型交互链路](./docs/scenario-interaction-chains.md)。

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
UPSTREAM_API_KEY1=你的对话模型真实key
UPSTREAM_API_KEY2=你的图片模型真实key
LITELLM_MASTER_KEY=换成你自己的本地访问key
LITELLM_MODEL=gpt-5.6
LITELLM_IMAGE_MODEL=gpt-image-2
```

再确认 `config.yaml` 里的模型映射：

```yaml
model_list:
  - model_name: gpt-5.6
    litellm_params:
      model: openai/gpt-5.6
      api_key: os.environ/UPSTREAM_API_KEY1
  - model_name: gpt-image-2
    litellm_params:
      model: openai/gpt-image-2
      api_key: os.environ/UPSTREAM_API_KEY2
```

`model_name` 是 Runtime 使用的 LiteLLM 平台别名，`model` 是中转站实际支持的上游模型名。`LITELLM_MODEL` 与 `LITELLM_IMAGE_MODEL` 必须分别对应 `config.yaml` 中的对话和图片别名；真实模型名、上游地址和 key 只保留在 LiteLLM 配置与服务端 `.env`，不会进入浏览器或 Run 请求。

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
  ghcr.io/berriai/litellm@sha256:89ccaccfda9083f7693777597ca27f8ffca12045e4fa9277155fb7c5f06e68b2 \
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
    "model": "gpt-5.6",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

## Runtime 模型网关配置

Agent Runtime 和模型连通性测试使用以下服务端配置：

```text
Base URL: http://localhost:4000/v1
API Key: 你的 LITELLM_MASTER_KEY
Chat model: gpt-5.6
Image model: gpt-image-2
```

这些配置不用于浏览器或普通业务客户端直连；业务请求统一通过 Agent Runtime API 进入平台。

### C2 真实图片模型 PoC

2026-07-31 使用锁定的 `ai@7.0.37`、`@ai-sdk/openai-compatible@3.0.14` 和当前 LiteLLM 配置，从 Runtime `image.generate` 主链完成一次真实模型 smoke：

- 服务端使用平台别名 `gpt-image-2`，模型调用只尝试 1 次，约 41.7 秒完成。
- 请求尺寸为 `1024x1024`，上游实际返回 `1254x1254` 的 `image/png`，共 1,091,928 字节；平台按真实返回内容计算并保存尺寸、MIME 和 SHA-256。
- 返回 usage 只有 `generated_images: 1`，token 字段为空，也没有可用成本字段，因此当前不能据此建立成本基线。
- 单张样本的提示词一致性和图片有效性观察通过，但内容安全、真实取消、超时、错误矩阵与多样本质量评测仍是 TODO。

因此，`imageOptions.size` 当前是平台允许提交的请求值，不是上游精确输出尺寸承诺。模型能力目录和尺寸归一化完成前，渠道应以 `image_asset.width` / `height` 的实际返回值为准。

## 交互 Demo

渠道页面使用 React 19、Ant Design X 2.9.0 和 X Markdown 2.9.0，通过 `demo/src/runtime-adapter.js` 适配既有 Runtime JSON/SSE API。页面不使用 Ant Design X SDK，不持有会话事实，也不改变 Agent Runtime、GatewayClient 或 LiteLLM 主链。

构建渠道页面并启动本地 Demo Server：

```bash
npm run demo
```

浏览器打开：

```text
http://localhost:4010
```

开发渠道页面时，可以分别启动 Runtime API 和 Vite 开发服务器：

```bash
npm run demo:server
npm run demo:ui
```

此时通过 `http://localhost:5173` 访问页面，Vite 会把 `/api` 请求转发到 `http://localhost:4010`。修改前端后可执行 `npm run demo:build` 生成 `demo/dist/` 静态产物。

交付渠道资源前运行构建与 gzip 预算门禁：

```bash
npm run demo:check
```

页面会请求本地 Demo Server，再由 Demo Server 装配的 Agent Runtime 通过 GatewayClient 和 AI SDK，使用 `.env` 里的 `LITELLM_MASTER_KEY` 调用 LiteLLM。浏览器不会拿到 `LITELLM_MASTER_KEY`、`UPSTREAM_API_KEY1` 或 `UPSTREAM_API_KEY2`。

Runtime 的唯一模型生成实现使用 AI SDK Core 和 `@ai-sdk/openai-compatible`，调用同一个 LiteLLM 地址、模型别名和访问 key。工具型主对话复用 GatewayClient 内的 `ToolLoopAgent`，通过 `callOptionsSchema` / `prepareCall` 按 Run 动态注入模型、工具和执行设置，并在每次调用传入取消、超时及 Runtime/Tool Context；无工具普通调用、MemoryDelta 等动态结构化输出和原始 `responseFormat` 兼容调用继续使用 `generateText` / `streamText`。它不会使用 `@ai-sdk/vercel` 直连 v0，也不会绕过模型网关；LiteLLM 专属的模型状态和 token counter 由独立管理客户端访问。

配置 `LITELLM_RUNTIME_KEY` 后，GatewayClient 优先使用该受限 virtual key 请求模型目录、token counter 和模型生成；`LITELLM_MASTER_KEY` 只保留给 LiteLLM 管理操作及旧本地环境兼容回退。浏览器通过 `/api/gateway/status` 看到的是同一 Runtime key 实际可见的平台模型别名，不会获得 virtual key、team ID 或上游模型配置。

### LiteLLM 治理 PoC

隔离治理入口使用 `docker-compose.gateway-governance.yml`，固定 LiteLLM `1.89.1`，并使用独立 PostgreSQL 保存 team、virtual key、预算和 spend。`config.gateway-governance.yaml` 提供 PoC 专属映射 `governance-smoke -> openai/gpt-5.4-mini`，不改变项目默认模型产品决策。

使用 `.env.gateway-governance.example` 中的本地变量启动治理网关后，先通过管理凭据幂等发布固定 Runtime team/key：

```bash
node scripts/provision-gateway-runtime-key.mjs
```

普通 Runtime 使用 `LITELLM_BASE_URL=http://127.0.0.1:4100`、`LITELLM_MODEL=governance-smoke` 和 `LITELLM_RUNTIME_KEY`。启动 Demo Server 后，可默认执行无费用的客户端模型目录检查；显式打开真实 Run smoke 时才调用上游模型：

```bash
node scripts/test-runtime-governance.mjs
LITELLM_GOVERNANCE_ENABLE_REAL_RUNTIME_SMOKE=true node scripts/test-runtime-governance.mjs
```

当前切片只验证一个本地应用身份。动态多租户 key 映射、正式 secret manager、轮换、撤销、Redis 多实例限流和 provider 账单对账仍未完成。

会话输入区的模型选择器读取 `GET /api/gateway/status` 返回的 `models`，这些值是当前 `LITELLM_MASTER_KEY` 在 LiteLLM `/v1/models` 中可见的稳定别名，不是真实上游模型配置。当前 `config.yaml` 分别配置 `gpt-5.6` 和 `gpt-image-2`；对话模式显示对话别名，生图模式固定显示服务端 `LITELLM_IMAGE_MODEL` 对应的图片别名。需要更多选项时，先在 LiteLLM `model_list` 中增加对应别名和上游映射。

Demo 输入区支持：

- 运行模式：显式选择“对话”或“生图”；生图固定使用服务端 `LITELLM_IMAGE_MODEL`，不会靠 Prompt 猜测，也不会允许浏览器选择真实 provider 参数。
- 正文：直接输入问题或指令。
- 图片：可以上传本地图片，也可以粘贴图片 URL；Demo Server 会按 OpenAI-compatible 的 `image_url` 多模态格式转发。
- 文档链接：可以粘贴一个或多个链接，Demo Server 会把它们作为文本上下文附在用户消息里。
- 消息引用：可以引用当前会话中的用户或助手消息；渠道只提交稳定 `messageId`，Runtime 从 SQLite 事实源解析正文。
- 模型选择：Sender 内选择当前 Run 使用的 LiteLLM 模型别名；未选择时回退服务端 `LITELLM_MODEL`，token counter 与模型生成使用同一别名。
- 多会话工作台：Runtime 使用 SQLite 持久化会话和完整原始消息；渠道支持标题搜索、今天/昨天/最近 7 天/更早分组、当前/归档/全部筛选、重命名与独立归档。归档不删除事实，取消归档也不会重新打开 `closed` 会话。
- 流式 Markdown：浏览器通过 POST SSE 接收 AI SDK 标准事件流的文本增量；普通调用使用 `streamText`，工具型对话使用 `ToolLoopAgent.stream()`，由 X Markdown 渲染并在完整回答结束后一次性落库。
- 停止生成：生成期间调用 Runtime 取消端点，中止模型调用、退避和后续重试；已有增量显示并保存为 `interrupted`。
- 图片产物：`image.generate` 固定单张和平台尺寸白名单，SDK 自动重试关闭；模型结果通过真实 MIME、字节和尺寸校验后写入 `DEMO_IMAGE_ASSET_DIR`，SQLite 只保存 `image_asset` 元数据与 Message/Run 引用，页面通过受控会话端点展示和下载。
- 发送门禁：本地会话先独立加载，模型网关状态在后台刷新；网关未确认可达时仍可浏览和整理会话、编辑草稿和附件，但禁止提交无效 Run。该探测只验证 LiteLLM `/v1/models`，不代表上游模型生成一定可用。
- 失败反馈与恢复：最近一次失败 Run 会在对应用户消息后说明鉴权、限流、超时、模型不可用或上游服务异常，并给出处理建议；页面不展示 provider 原始错误正文。失败可直接重试或编辑后发送，最后一条正常助手回答可重新生成，中断回答可继续生成；每次动作都使用新的幂等标识，并以 `sourceRunId + recoveryMode` 记录来源而不修改历史。
- 多端同步：同一会话通过独立的 SSE 事件游标刷新已持久化事实；客户端不再保存或提交历史事实源。
- 消息操作：已持久化消息不提供删除或原位编辑；桌面在消息悬停或操作聚焦时显示快捷操作，移动端收敛为单一操作菜单。助手 Markdown 支持整段复制、代码块复制、回答标题导航、安全外链、移动端表格横向滚动和下载 `.md`。
- 会话导航：桌面会话区左侧将用户发起的消息聚合为居中的等长锚点；悬停时刻度横向展开并预览摘要，点击后按稳定 `messageId` 定位并高亮原消息，助手回复不生成锚点。
- 会话草稿：当前标签页的 `sessionStorage` 按稳定 `conversationId` 隔离正文、远程附件、引用和模型选择；切换会话或刷新页面会恢复各自草稿。出于体积与隐私边界，本地图片 `data:` 内容只保留在页面内存，不写入 session 草稿。
- 长列表与跟随：会话摘要和消息都按固定窗口渐进加载；位于底部时继续跟随流式回答，用户主动向上浏览后保留当前视窗并显示“回到最新”。活动回答附近只展示 `starting / running / stopping` 已有事实对应的渠道状态。
- 可访问性与响应式：会话搜索和新建支持键盘命令，生成状态使用 `aria-live` 礼貌播报；移动断点的主要图标按钮保持至少 44px 触控目标，并支持 `prefers-reduced-motion`。
- 结构化记忆：Memory Manager 提取目标、约束、偏好、事实、决策、任务和 Episode，用户纠正会废弃旧事实并保留来源消息。
- 运行上下文：桌面默认收起 Inspector，按需展开；移动端通过 Drawer 展示 Context Manifest、Token 装箱结果与 active 结构化记忆。引用预览可按稳定 `messageId` 定位并高亮原消息。
- Token 水位：动态原始消息达到 75% 高水位后压缩到 45% 低水位；接近 90% 硬水位时先同步压缩再回答。

当前服务端已为 `get_weather` 提供真实的 `tool-started`、`tool-completed` 和 `tool-failed` 阶段事件，页面据此展示“正在查询实时天气”；普通模型生成没有对应的服务端阶段证据，因此仍不展示 `Think` 或 `ThoughtChain`，也不会把模型原始思维链作为体验数据。

注意：LiteLLM Proxy 只负责转发请求，不会自动打开文档链接、读取私有文档，也不会自动提取文档里的图片。如果要让模型处理文档里的图片，需要把图片单独上传，或提供可公开访问的图片直链，并确保当前上游模型支持视觉输入。

当前图片生成已完成一次真实模型 smoke。后续更换图片模型、上游映射或 key 后，应重新启动 LiteLLM 与 Demo，在输入区切到“生图”并提交一条安全提示词；只有页面返回可打开的图片资产、会话刷新后仍可读取，才算新配置的 happy-path 复验通过。

## C1 ChainTrace 后端（预留，默认关闭）

C1 ChainTrace 已接受 Phoenix 19.10.0 + PostgreSQL 17 作为后续正式后端。Runtime 仍只依赖项目自有 `ChainTracer` Port，通过 OTLP/HTTP protobuf 旁路导出；Phoenix 不保存或决定 Conversation、Run、Message 和 Memory 业务事实。

当前阶段保持 `OTEL_ENABLED=false`，正常启动 LiteLLM、Demo Server 和 Runtime 不需要启动 Phoenix。正式实例与真实 Runtime Trace 验收是 TODO；当出现难以通过 Run 状态和日志定位的问题、需要 P50/P95/重试/Token 基线、进入多人共享或准生产部署时，再执行下面的启用流程。

恢复 TODO 时，先在 `.env` 中替换 `PHOENIX_POSTGRES_PASSWORD`、`PHOENIX_SECRET` 和 `PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD`，再启动固定 digest 的 Phoenix 与 PostgreSQL：

```bash
docker compose --env-file .env -f docker-compose.chaintrace.yml up -d
```

浏览器访问 `http://localhost:6006`，使用 `admin@localhost` 和首次启动密码登录并立即修改密码，然后在 Settings 创建 system API key。将 key 写入服务端 `.env` 的标准 OTel header，空格使用 `%20`：

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=authorization=Bearer%20你的system-api-key
```

TODO 验收目标是：重启 Demo Server 并执行一个真实 JSON 或 SSE Run，在 Phoenix 按 `ai.platform.request_id`、`ai.platform.conversation_id` 和 `ai.platform.run_id` 精确定位同一 Trace，再完成 Span 完整性、敏感数据和 exporter 故障隔离检查。完整触发条件、健康检查、认证验证、备份和升级边界见 [C1 ChainTrace 运行态验收延期决策](./docs/decisions/2026-07-30-c1-chaintrace-runtime-validation-deferral.md) 与 [C1 ChainTrace 运维说明](./docs/c1-chaintrace-operations.md)。

Demo Server API 按层级暴露：

| API | 说明 |
| --- | --- |
| `GET /api/gateway/status` | 检查 LiteLLM `/v1/models` 可达性，并返回 gateway base url、默认对话别名、服务端图片别名和当前 key 可见的 `models` |
| `GET /api/runtime/conversations` | 列出持久化会话 |
| `POST /api/runtime/conversations` | 创建会话 |
| `GET /api/runtime/conversations/{id}` | 查询完整消息、结构化记忆和版本状态 |
| `PATCH /api/runtime/conversations/{id}` | 更新 1-80 字符标题或独立归档状态，不改变会话生命周期 |
| `POST /api/runtime/conversations/{id}/runs` | 按显式 `operation` 发送当前输入并执行幂等 Run；图片结果通过 `artifacts` 返回 |
| `POST /api/runtime/conversations/{id}/runs/stream` | 通过 SSE 接收 `run-started`、文本 `text-delta` 或图片 `artifact-created`，再以 `completed`、`cancelled` 或 `error` 收口 |
| `POST /api/runtime/conversations/{id}/runs/{runId}/cancel` | 主动取消模型调用与后续重试，并返回最终 Run 和可选中断消息 |
| `GET /api/runtime/conversations/{id}/image-assets/{assetId}/content` | 校验资产属于当前会话后读取生成图片内容，不暴露物理路径 |
| `POST /api/runtime/conversations/{id}/close` | 完成最终 checkpoint 并结束会话 |
| `GET /api/runtime/conversations/{id}/events` | 订阅多端增量事件流 |

Run 请求包含模型别名、当前输入和幂等标识；恢复动作额外携带可选来源：

```json
{
  "operation": "conversation.chat",
  "requestId": "request-uuid",
  "clientMessageId": "message-uuid",
  "model": "gpt-5.6",
  "message": "当前问题",
  "imageUrls": [],
  "documentUrls": [],
  "sourceRunId": "可选的来源 Run ID",
  "recoveryMode": "retry | regenerate | continue",
  "references": [
    {
      "type": "conversation_message",
      "messageId": "当前会话中的消息 ID"
    }
  ]
}
```

图片生成使用独立操作与服务端图片模型别名，不接受附件、引用或 provider 专属参数：

```json
{
  "operation": "image.generate",
  "requestId": "image-request-uuid",
  "clientMessageId": "image-message-uuid",
  "model": "gpt-image-2",
  "message": "生成一张白底红色印章图片",
  "imageOptions": {
    "size": "1024x1024"
  }
}
```

当前只开放 `conversation_message` 引用。Runtime 会校验消息属于当前会话，并从 SQLite 事实源读取正文；渠道重复提交的引用正文不会被信任。`retry`、`regenerate`、`continue` 的来源状态必须分别为 `failed`、`completed`、`cancelled`，恢复动作仍创建新 Run。显式取消后，已有文本增量时最多保存一条 `interrupted` 助手消息，没有增量时不创建空消息；关闭浏览器或 SSE 断线不等于取消。

## Runtime 验证

运行 Gateway Client 协议兼容、会话、幂等、结构化记忆、乐观锁、关闭会话和架构边界回归：

```bash
npm test
```

只检查全局架构边界：

```bash
npm run test:architecture
```

只验证 C2 图片调用、结果校验、资产落存、幂等、取消和超时边界：

```bash
npm run test:images
```

只验证 C1 ChainTrace 的 JSON/SSE Span 树、重试关联、失败脱敏、幂等重放和 Token 分段：

```bash
npm run test:telemetry
```

运行 100 轮长期记忆评测：

```bash
node .agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs
```

评测会在第 45 轮把当前项目消息队列从 RabbitMQ 更正为 Kafka，并验证 100 轮后仍能正确回答，同时隔离另一个仍使用 RabbitMQ 的项目。

默认场景保存在 `.agents/skills/docs/context-memory-evaluation/assets/fixtures/message-queue-correction-100.json`。新增评测场景只增加 fixture，并通过 `--fixture <path>` 传给通用 runner，不修改脚本判分逻辑。

## 配置与密钥

- `gpt-5.6` 和 `gpt-image-2` 是当前 LiteLLM 对话与图片模型别名；Runtime 分别通过 `LITELLM_MODEL` 和 `LITELLM_IMAGE_MODEL` 使用，浏览器和普通业务客户端不接触真实上游配置。
- `model_list[].litellm_params.model` 是 LiteLLM 转发给中转站的真实模型名。中转站是 OpenAI-compatible 时，通常保留 `openai/` 前缀。
- `UPSTREAM_API_BASE` 通常要带 `/v1`。
- `UPSTREAM_API_KEY1` 和 `UPSTREAM_API_KEY2` 分别是当前对话、图片模型的上游真实 key，只应放在服务端 `.env`。
- `LITELLM_MASTER_KEY` 是 Runtime 和模型连通性诊断访问内部模型网关的服务端凭据，不提供给浏览器或普通业务客户端；部署前请改成强随机值。
- `LITELLM_BASE_URL` 是 Runtime 使用的 LiteLLM Proxy 根地址，默认 `http://localhost:4000`，不要追加 `/v1`。
- `LITELLM_MODEL` 是 Runtime 请求的对话模型别名；当前示例配置为 `gpt-5.6`。
- `LITELLM_IMAGE_MODEL` 是 Runtime 请求的图片模型别名；当前示例配置为 `gpt-image-2`，必须与 `config.yaml` 的图片 `model_name` 完全一致。
- `DEMO_DATABASE_PATH` 是 Runtime SQLite 文件，默认 `.data/ai-platform.sqlite`。
- `DEMO_IMAGE_ASSET_DIR` 是开发阶段图片二进制目录，默认 `.data/image-assets`；SQLite 只保存资产元数据和引用。
- `DEMO_CONTEXT_HIGH_WATERMARK_RATIO`、`DEMO_CONTEXT_LOW_WATERMARK_RATIO` 和 `DEMO_CONTEXT_HARD_WATERMARK_RATIO` 控制压缩水位。
- `DEMO_RUN_TIMEOUT_MS` 是排队、上下文规划和全部模型尝试共享的 Run 总时限，默认 `120000` 毫秒。
- `DEMO_MODEL_MAX_ATTEMPTS` 默认 `3`，包含首次调用；退避由 `DEMO_MODEL_RETRY_BASE_DELAY_MS` 和 `DEMO_MODEL_RETRY_MAX_DELAY_MS` 控制。
- `DEMO_TOOL_MAX_STEPS` 默认 `4`，限制一次 Run 内 `ToolLoopAgent`（或动态结构化特殊路径）的模型步骤；`DEMO_WEATHER_TOOL_ENABLED` 默认启用首个只读天气工具。
- `DEMO_WEATHER_TIMEOUT_MS` 默认 `8000` 毫秒；天气 Connector 只访问代码内固定的 Open-Meteo Geocoding 与 Forecast HTTPS 端点，不接受渠道或模型传入 URL。
- 当前输入包含明确地点且查询今天或明天天气时，服务端 Registry 会通过 AI SDK `prepareStep` 把首步确定性路由到 `get_weather`，后续步骤恢复 `auto`；缺少地点或超出日期范围时仍由模型澄清，不把任意文本转换为外部请求。
- 工具结果落库后若后续模型步骤因瞬时错误失败，且尚未交付正文，Runtime 会从 SQLite ToolResult 构造 AI SDK 结构化工具消息并发起无工具总结恢复；恢复仍共享原 Run 时限和取消信号，不会再次执行 Connector，也不提供跨进程任务恢复。
- `OTEL_ENABLED` 控制 C1 ChainTrace，默认 `false`；禁用时不初始化 SDK、Exporter 或 AI SDK Telemetry。
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 是启用 TODO 时使用的 Phoenix OTLP HTTP 地址；代码固定使用 protobuf，也兼容以 `OTEL_EXPORTER_OTLP_ENDPOINT` 提供基础地址。
- `OTEL_EXPORTER_OTLP_TRACES_HEADERS` 和 `OTEL_EXPORTER_OTLP_HEADERS` 使用 OTel `key=value` 列表；Trace 专用 header 优先，凭据只保存在服务端内存。
- `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` 默认 `10000` 毫秒，exporter 超时、认证失败或后端不可用不改变 Run 语义。
- `OTEL_SERVICE_NAME` 默认 `ai-platform-demo`；`OTEL_TRACES_SAMPLER_ARG` 是 `parentbased_traceidratio` 的根 Trace 采样比例，范围为 `0` 到 `1`。
- TODO 恢复后的 Phoenix 正式部署启用 Auth、30 天默认保留和关闭匿名 telemetry；Runtime 不引入 Phoenix 私有 SDK，也不向 SQLite 增加 Trace 副本。

## 文档与规范

| 信息 | 放置位置 |
| --- | --- |
| 启动、Runtime 配置、Demo 使用和模型连通性验证 | `README.md` |
| AI 协作规则、文档路由、提交规范 | `AGENTS.md` |
| Agent Skill 索引、目录规范、治理规则 | `.agents/skills/README.md` |
| 调用链路、模块分层、配置边界、演进路线 | `docs/ai-structure.md` |
| 共同底座边界、重试与恢复策略、七条场景链路、当前 C1 焦点、质量指标和建设顺序 | `docs/scenario-interaction-chains.md` |
| Phoenix ChainTrace TODO 的触发条件与阶段决策 | `docs/decisions/2026-07-30-c1-chaintrace-runtime-validation-deferral.md` |
| Phoenix ChainTrace 启用、认证、健康检查、备份与升级边界 | `docs/c1-chaintrace-operations.md` |
| V1 只读工具循环、天气 Connector 和 LiteLLM digest 决策 | `docs/decisions/2026-07-30-v1-read-only-tool-loop-and-weather.md` |
| ToolResult 持久化总结恢复决策 | `docs/decisions/2026-07-31-tool-result-summary-recovery.md` |
| AI SDK Core v7 当前采用、延后与不采用的 API 边界 | `docs/ai-sdk-core-alignment.md` |
| C2 图片理解与生成的场景归属、模型调用和资产边界 | `docs/decisions/2026-07-31-c2-image-understanding-and-generation-boundary.md` |
| 会话、结构化记忆、上下文规划、并发和评测 | `docs/context-management.md` |
| 函数注释、数据结构、设计模式和设计原则 | `docs/coding-standards.md` |
| 项目级技术约定 | `openspec/project.md` |
| 平台当前集成切片、Demo API、鉴权、模型别名、上下文预算等稳定契约 | `openspec/specs/ai-platform/spec.md` |

Skill 相关内容统一放在 `.agents/skills/`，并遵守 `https://gitlab.seakoi.net/seakoi/skills` 仓库的指南、要求、原则。修改 Skill 后可运行 `node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs` 校验目录与 frontmatter。修改代理行为、Demo API、鉴权、模型别名或上下文预算时，需要同步 OpenSpec；只调整启动说明、示例命令或文案时，通常更新 README 或 docs 即可。

## 后续升级方向

当前保持单仓和轻量部署，先稳定区域接口，再按跨项目复用、独立安全边界、独立扩缩容或团队所有权逐个拆成服务：

1. V1：已适配 AI SDK Core `generateText` / `streamText` 的有界多步工具能力，以 Open-Meteo 天气查询跑通无副作用只读工具闭环，并支持从持久化 ToolResult 无工具恢复最终总结；真实模型 smoke test、更多业务 Connector、人工确认、写操作和跨进程恢复仍未完成。
2. V2：把 LiteLLM 模型网关补成团队共享服务，增加 virtual key、多模型路由、fallback、预算、限流和调用统计。
3. V3：按资源和权限边界拆出连接器服务与知识服务。
4. V4：建设平台控制面和多渠道 Adapter，复用已经稳定的 Runtime、连接器和模型网关。
5. 治理与可观测贯穿所有阶段，通过统一身份上下文和事件结构接入，不成为同步调用单点。

区域定义、依赖规则、数据所有权、服务拆分条件和 V0.5-V4 实施对比见 `docs/ai-structure.md`。

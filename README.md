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

严格意义上的 AI Gateway 只指第 5 个区域。项目、仓库和目录统一使用 `ai-platform`；拆出的模型网关服务使用 `model-gateway`。当前代码落地的是开发 Demo、Agent Runtime 及其 GatewayClient、LiteLLM 模型网关、首个有界只读天气工具闭环，以及版本化执行策略、Operation journal 和 SQLite RunLease/fencing 执行治理基础；未来正式平台作为新的控制面和渠道调用方接入，不替换 Runtime、连接器或模型网关。

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
  -> AI SDK Core / Responses 图片编辑 Adapter
  -> LiteLLM Proxy
  -> 上游 OpenAI-compatible API
```

浏览器 Demo 不直接调用 LiteLLM 或上游中转站；它只请求本地 Demo Server，由 Agent Runtime 通过统一 GatewayClient 访问模型网关。

模型执行和同步输出共用同一个 Run，但职责分开：

```text
Agent Runtime
  -> RunEventSink（易失、有序、不可变的生命周期事件）
       -> Demo Server SSE Adapter -> POST .../runs/stream
  -> SQLite 事务事实 -> conversation_events
       -> 游标 SSE -> 多端状态同步

Runtime 返回 / 抛错 -> Demo Server 渠道终态交付
                     -> completed / cancelled / error
```

`RunEventSink` 只负责进程内实时观察，订阅者失败不会把模型、工具或已提交 Run 改写为失败；它按顺序等待当前本地订阅者，因此不能直接承载远程消费、积压、重放或保证送达。POST SSE 的事件名和公开载荷属于 Demo Server Adapter，SQLite `conversation_events` 才是可恢复的会话事实历史。

执行治理采用三块可替换边界：`ExecutionPolicy` 只做版本化前置决策和后置观察，不访问 Store 或 Connector；`ConversationStore` 独占 Operation、ToolCall 和 RunLease 事实；Runtime 负责按策略取得 lease、调用下游并携带 fencing token 提交。未知操作默认拒绝，未显式允许的 `write`、`external` 或 `unknown` 操作默认要求确认；当前 `image.generate` 和 `image.edit` 是显式允许的本地图片资产写入开发切片，不因此获得通用副作用恢复。

`scripts/test-chat.sh -> LiteLLM -> 上游模型` 仅用于检查模型连通性和排障，不属于全局业务链路、平台能力规划或客户端接入方式。

当前交付以 C1 对话问答为基线，并以 Open-Meteo 跑通首个只读天气工具。天气切片已从“保存 ToolResult”推进到“服务重启后从 completed ToolResult 恢复最终总结”：恢复实例会先被未过期 lease 阻断，过期后以递增 fencing token 接管，并通过持久化 `AcceptanceResult` 独立检查地点、数据时间、来源和结果事实；该能力只覆盖一个已证明的只读稳定点，不等于通用持久工作流或生产级多实例协调。项目同时增加 C2 文生图与多轮单图编辑开发切片：普通新请求默认提交 `operation=auto`，Runtime 从当前附件和有界会话 routing snapshot 形成候选，再复用 AI SDK `Output.object` 返回 operation/confidence/useActiveImage/relevantMessageIds；Runtime 校验证据并选择实际源图，图片生成或编辑只有在候选合法且 `confidence >= 0.85` 时自动执行，不确定或分类失败回退普通对话。受控源图上传、会话级图片资产、操作级默认模型、结果校验、幂等重放、取消、连续版本、无附件活动图片续接和 JSON/SSE 交付已经通过 fake 回归。`image.generate` 已用 `gpt-image-2` 跑通一次真实模型 happy-path smoke；旧 `/images/edits` 路径连续三次被账号池拒绝后，`image.edit` 改用 Responses `image_generation(action=edit)`，并于 2026-08-15 用当前 `gpt-5.6` 配置跑通两轮 A→B→C 真实编辑 smoke。同日新增 `scenarios/runtime-routing/` 双模式 Runner：确定性链路通过，真实分类 smoke 的 4/4 个有效样本中，operation、源图引用/字节、视觉输入、编辑 Prompt 历史、证据和活动图片均命中且错误图片副作用为 0；由于样本少于 30，该结果只属于 `observation-only`，不构成发布准确率。内容审核、完整路由样本矩阵、精确尺寸、成本基线、取消/超时/错误矩阵、正式对象存储和图片理解资产输入仍未完成。具体等级与边界见[运行可靠性与结果验收](./docs/runtime-reliability-and-acceptance.md)和[场景化输入到大模型交互链路](./docs/scenario-interaction-chains.md)。

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
LITELLM_IMAGE_EDIT_MODEL=gpt-5.6
LITELLM_CHAT_MODELS=gpt-5.6
LITELLM_VISION_MODELS=gpt-5.6
LITELLM_IMAGE_EDITING_MODELS=gpt-5.6
```

再确认 `config.yaml` 里的模型映射：

```yaml
model_list:
  - model_name: gpt-5.6
    litellm_params:
      model: openai/gpt-5.6-sol
      api_key: os.environ/UPSTREAM_API_KEY1
      num_retries: 0
  - model_name: gpt-image-2
    litellm_params:
      model: openai/gpt-image-2
      api_key: os.environ/UPSTREAM_API_KEY2
      num_retries: 0
```

`model_name` 是 Runtime 使用的 LiteLLM 平台别名，`model` 是中转站实际支持的上游模型名。当前稳定别名 `gpt-5.6` 映射到上游实际存在且已通过视觉 smoke 的 `gpt-5.6-sol`。`LITELLM_MODEL`、`LITELLM_IMAGE_MODEL` 与 `LITELLM_IMAGE_EDIT_MODEL` 分别声明对话、图片生成和 Responses 图片编辑默认别名；`LITELLM_CHAT_MODELS`、`LITELLM_VISION_MODELS` 与 `LITELLM_IMAGE_EDITING_MODELS` 声明静态操作能力，不能只凭 `/v1/models` 可见性推断。承载图片副作用的两个映射均固定 `num_retries: 0`，避免 LiteLLM 在不确定失败后绕过 Runtime 的单次图片尝试边界。真实模型名、上游地址和 key 只保留在 LiteLLM 配置与服务端 `.env`，不会进入浏览器或 Run 请求。

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
Image generation model: gpt-image-2
Image editing model: gpt-5.6
```

这些配置不用于浏览器或普通业务客户端直连；业务请求统一通过 Agent Runtime API 进入平台。

### C2 真实图片模型 PoC

2026-07-31 使用锁定的 `ai@7.0.37`、`@ai-sdk/openai-compatible@3.0.14` 和当前 LiteLLM 配置，从 Runtime `image.generate` 主链完成一次真实模型 smoke：

- 服务端使用平台别名 `gpt-image-2`，模型调用只尝试 1 次，约 41.7 秒完成。
- 请求尺寸为 `1024x1024`，上游实际返回 `1254x1254` 的 `image/png`，共 1,091,928 字节；平台按真实返回内容计算并保存尺寸、MIME 和 SHA-256。
- 返回 usage 只有 `generated_images: 1`，token 字段为空，也没有可用成本字段，因此当前不能据此建立成本基线。
- 单张样本的提示词一致性和图片有效性观察通过，但内容安全、真实取消、超时、错误矩阵与多样本质量评测仍是 TODO。

因此，`imageOptions.size` 当前是平台允许提交的请求值，不是上游精确输出尺寸承诺。模型能力目录和尺寸归一化完成前，渠道应以 `image_asset.width` / `height` 的实际返回值为准。

图片编辑使用独立 `image.edit` 操作和操作级编辑默认模型。浏览器先把一张 PNG、JPEG 或 WebP 本地图片上传为当前会话拥有的 `source=uploaded` 资产，再只把稳定 `assetId` 提交给 Run；Runtime 读取源图后由 GatewayClient 的受控 Adapter 经 LiteLLM `/v1/responses` 发起 `image_generation(action=edit)` 请求。成功结果保存为新的 `source=edited` 资产并自动成为下一轮当前源图，历史生成或编辑结果也提供“继续编辑”；每轮创建新 Run 和新资产，旧版本保持不变。当前上传上限为 5 MiB，不支持遮罩、局部重绘、多图融合或远程 URL 导入。

2026-08-01 使用无敏感内容的合成 PNG 连续执行三次真实 `/images/edits` 请求，均被上游账号池以无兼容账号拒绝；该证据触发了方案重评。2026-08-02 按官方会话式图片编辑建议执行 Responses 对照 PoC：同一 `gpt-5.6` 别名的纯文本 `/v1/responses` 返回 `200 completed`，加入一张合成图和 `image_generation(action=edit)` 后返回 502，上游拒绝图片工具访问。2026-08-15 使用当前配置重新验证：Demo 普通发送将单张受控图片和明确优化指令以 `operation=auto` 交给 Runtime，并解析为 `image.edit`，两次单尝试分别约 70.7 秒和 69.2 秒完成；第二轮用户消息只引用第一轮输出资产，A/B/C 三张 PNG 的哈希各不相同，刷新会话后两个输出仍可读取。同日对无业务信息合成图执行协议字段对照：`action=edit` 与增加 `tool_choice` 分别约 33.5 秒和 30.7 秒返回 200 图片结果，增加 `max_tool_calls=1` 后当前中转站返回 502；因此 Adapter 保留强制工具选择，并通过唯一 completed 图片结果解析收口，不发送该不兼容字段。以上证据补齐当前配置的真实多轮 happy path 和协议兼容边界，但样本量、内容安全、质量和成本仍不足以支撑生产可用声明。

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

会话输入区同时读取 `GET /api/gateway/status` 的 `models`、`defaultModels` 和 `modelCapabilities`。`models` 只表示当前 Runtime key 在 LiteLLM `/v1/models` 中可见的稳定别名，`defaultModels` 分别声明对话、图片生成和图片编辑默认别名，能力分组按 `chat`、`vision`、`imageGeneration` 和 `imageEditing` 声明服务端操作兼容策略；目录可见不等于能力兼容或上游账号健康。当前图片生成使用 `gpt-image-2`，图片编辑使用支持 Responses 工具调用的 `gpt-5.6` 平台别名。增加模型时必须同时更新 LiteLLM 映射、Runtime key 模型白名单和对应服务端能力策略。

Demo 输入区支持：

- 默认路由：普通输入区不展示模式或模型选择器，只提交正文、当前附件和 `operation=auto`。Runtime 从服务端消息/Run/资产事实派生活动图片：无当前附件且存在活动图片时从对话/生图/编辑中分类，无活动图片时从对话/生图中分类，恰好一张当前会话受控图片时从对话/编辑中分类；远程图片、文档或多图固定走对话。图片操作必须达到 `0.85` 置信度；编辑成功后的最新结果成为服务端活动图片，普通聊天和刷新不会依赖浏览器缓存清空它。
- 正文：直接输入问题或指令。
- 图片：可以上传本地图片，也可以粘贴图片 URL；Demo Server 会按 OpenAI-compatible 的 `image_url` 多模态格式转发。
- 文档链接：可以粘贴一个或多个链接，Demo Server 会把它们作为文本上下文附在用户消息里。
- 消息引用：可以引用当前会话中的用户或助手消息；渠道只提交稳定 `messageId`，Runtime 从 SQLite 事实源解析正文。
- 模型选择：普通 Composer 不提交模型别名，Runtime 按解析后的真实 operation 使用服务端 `defaultModels`；历史图片继续编辑与恢复入口也只使用服务端能力兼容的操作级默认别名。Runtime 和 GatewayClient 会独立校验，错配以 `model_capability_mismatch` 在生成调用前拒绝。
- 多会话工作台：Runtime 使用 SQLite 持久化会话和完整原始消息；渠道支持标题搜索、今天/昨天/最近 7 天/更早分组、当前/归档/全部筛选、重命名与独立归档。归档不删除事实，取消归档也不会重新打开 `closed` 会话。
- 流式 Markdown：Runtime 使用 `streamText` 或 `ToolLoopAgent.stream()` 生成文本增量，经 `RunEventSink -> Demo Server SSE Adapter` 映射为 POST SSE；Runtime 不依赖 SSE 协议。天气候选在系统验收前只暂存在 Runtime，验收通过并提交终态后才发布；其他普通回答继续实时透传，最终都只落一条完整助手消息。
- 停止生成：收到 `run-started` 前按 `requestId`、之后按 `runId` 调用显式取消端点，中止分类、模型调用、退避和后续重试；已有增量显示并保存为 `interrupted`。
- 图片资产：`image.generate` 固定单张和平台尺寸白名单；`image.edit` 要求一张当前会话受控源图。两者都关闭 SDK 自动重试，模型结果通过真实 MIME、字节和尺寸校验后写入 `DEMO_IMAGE_ASSET_DIR`；SQLite 只保存 `image_asset` 元数据与 Message/Run 引用，页面通过受控会话端点展示和下载。
- 发送门禁：本地会话先独立加载，模型网关状态在后台刷新；网关未确认可达时仍可浏览和整理会话、编辑草稿和附件，但禁止提交无效 Run。该探测只验证 LiteLLM `/v1/models`，不代表上游模型生成一定可用。
- 失败反馈与恢复：最近一次失败 Run 会在对应用户消息后说明鉴权、限流、超时、模型不可用或上游服务异常，并给出处理建议；页面不展示 provider 原始错误正文。失败可直接重试或编辑后发送，最后一条正常助手回答可重新生成，中断回答可继续生成；每次动作都使用新的幂等标识，并以 `sourceRunId + recoveryMode` 记录来源而不修改历史。
- 启动恢复：Demo Server 监听端口前扫描 SQLite 中遗留的 `running` Run。只有 completed 只读 ToolResult、完整恢复元数据、无助手消息且原截止时间未耗尽时继续最终总结；其他遗留 Run 使用稳定原因码明确失败，不猜测或重放图片、写操作和未知状态。
- 结果验收：天气模型输出先是候选。Runtime 根据 SQLite ToolResult 独立检查地点、数据时间、来源和至少一个结果事实；accepted 结果与助手消息、Run 完成同事务提交，rejected 结果不保存候选正文。普通对话当前返回 `acceptance=null`，不宣称已经系统验收。
- 图片失败语义：Responses 图片编辑协议或工具权限不可用时返回独立安全错误，不展示 provider 原始正文或上游分类码。`retry / regenerate / continue` 继承来源 Run 已持久化的真实 operation，不再执行意图分类；历史图片上的“继续编辑”仍创建新的普通 `image.edit` Run。
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

当前图片生成已完成一次真实 happy path，Responses 图片编辑也已完成两轮 A→B→C 真实 happy path；旧 Image API 编辑路径仍保留三次账号池拒绝的历史证据。更换上游映射、key 或图片模型版本后，应重新启动 LiteLLM 与 Demo，分别复验“生图”和至少连续两轮“图生图”：只有 A→B→C 都返回可打开图片、第二轮确实以 B 为源且会话刷新后 A/B/C 仍可读取，才算新配置继续具备真实生成与多轮编辑 happy path；失败或未执行的模式必须重新标记为 TODO。

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
| `GET /api/gateway/status` | 检查 LiteLLM `/v1/models` 可达性，并返回 gateway base url、默认别名、可见 `models` 与四组静态 `modelCapabilities`；不代表上游账号健康 |
| `GET /api/runtime/conversations` | 列出持久化会话 |
| `POST /api/runtime/conversations` | 创建会话 |
| `GET /api/runtime/conversations/{id}` | 查询完整消息、结构化记忆、版本状态，以及 `latestRun` 可空的 `acceptance` 事实 |
| `PATCH /api/runtime/conversations/{id}` | 更新 1-80 字符标题或独立归档状态，不改变会话生命周期 |
| `POST /api/runtime/conversations/{id}/image-assets` | 以原始二进制上传一张 PNG、JPEG 或 WebP 源图，校验后登记为当前会话拥有的 `image_asset`；上传本身不创建 Run |
| `POST /api/runtime/conversations/{id}/runs` | 普通新请求默认按 `operation=auto` 解析并持久化真实 operation；显式兼容和恢复请求保持原 operation，图片结果通过 `artifacts` 返回 |
| `POST /api/runtime/conversations/{id}/runs/stream` | 通过 SSE 接收 `run-started`、文本 `text-delta` 或图片 `artifact-created`，再以 `completed`、`cancelled` 或 `error` 收口 |
| `POST /api/runtime/conversations/{id}/run-requests/{requestId}/cancel` | 在 `run-started` 前按请求身份中止排队或结构化分类；不创建伪 Run |
| `POST /api/runtime/conversations/{id}/runs/{runId}/cancel` | 主动取消模型调用与后续重试，并返回最终 Run 和可选中断消息 |
| `GET /api/runtime/conversations/{id}/image-assets/{assetId}/content` | 校验资产属于当前会话后读取上传、生成或编辑图片内容，不暴露物理路径 |
| `POST /api/runtime/conversations/{id}/close` | 完成最终 checkpoint 并结束会话 |
| `GET /api/runtime/conversations/{id}/events` | 订阅多端增量事件流 |

普通新 Run 默认不提交模型别名，由 Runtime 解析真实 operation 后选择服务端默认模型：

```json
{
  "operation": "auto",
  "requestId": "request-uuid",
  "clientMessageId": "message-uuid",
  "message": "当前问题",
  "imageUrls": [],
  "documentUrls": [],
  "references": []
}
```

`retry / regenerate / continue` 恢复动作额外携带 `sourceRunId` 和 `recoveryMode`，并继承来源 Run 已持久化的真实 operation；恢复请求不得使用 `auto` 重新分类。

需要强制文生图的显式兼容调用仍可提交独立 operation；它不接受附件、引用或 provider 专属参数：

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

普通图片优化先调用上面的图片资产上传入口，再以默认 `auto` 提交一张当前会话资产的稳定引用和文字指令；Run JSON 不携带浏览器模型、源图片二进制、MIME、尺寸或物理地址：

```json
{
  "operation": "auto",
  "requestId": "image-edit-request-uuid",
  "clientMessageId": "image-edit-message-uuid",
  "message": "保留构图并改成蓝色水彩风格",
  "references": [
    {
      "type": "image_asset",
      "assetId": "当前会话上传返回的资产 ID"
    }
  ],
  "imageOptions": {
    "size": "1024x1024"
  }
}
```

自动模式的附件与会话矩阵是硬约束：恰好一张当前会话受控 `image_asset` 且没有其他附件时只候选 `conversation.chat / image.edit`，该显式图片覆盖历史活动图片；无当前附件但存在活动图片时候选 `conversation.chat / image.generate / image.edit`；没有活动图片时只候选 `conversation.chat / image.generate`；任意远程图片 URL、文档、多图或消息引用只允许不继承活动图片的对话。分类模型只能返回 `operation / confidence / useActiveImage / relevantMessageIds`，Runtime 会校验历史证据、引用所有权和资产状态，从 SQLite 事实选择源图并组装实际编辑指令；渠道重复提交的正文、MIME、尺寸、URL 或二进制不会被信任。Run 持久化真实 operation、实际图片引用和脱敏 `intentDecision`，不保存 provider 原始分类文本或隐藏推理。

继续编辑上一版图片属于新的显式 `image.edit` Run：使用新 requestId/clientMessageId，并把上一版输出 assetId 作为唯一源图，不设置 recovery 字段。`retry`、`regenerate`、`continue` 的来源状态必须分别为 `failed`、`completed`、`cancelled`，恢复动作继承来源 Run 的真实 operation 且不重新分类。显式取消后，已有文本增量时最多保存一条 `interrupted` 助手消息，没有增量时不创建空消息；分类期按 requestId 取消时不创建消息或 Run。关闭浏览器或 SSE 断线不等于取消。

## Runtime 验证

运行 Gateway Client 协议兼容、会话、幂等、结构化记忆、乐观锁、关闭会话和架构边界回归：

```bash
npm test
```

只验证结果验收策略和两个真实 Node 进程组成的 ToolResult 后崩溃/重启场景：

```bash
npm run test:acceptance
npm run test:scenarios
```

输出每个确定性场景的逐项验收、模型调用阶段和 SQLite 证据：

```bash
npm run eval:runtime-scenarios:deterministic
```

使用同一版本化场景资产评测真实模型最终回答。真实模式不提供默认模型别名，调用方必须为每次评测显式固定模型别名：

```bash
npm run eval:runtime-scenarios:real -- --model <fixed-model-alias>
```

双模式的 setup 都使用固定行为模型构造 ToolResult 已提交的稳定故障点。`deterministic` 的 evaluation 只证明 Runtime、SQLite、恢复和判分链路；`real-model` 的 evaluation 才经过现有 `GatewayClient -> AI SDK -> LiteLLM -> 上游模型`。真实调用失败直接失败，不回退固定模型。报告分别写入 `.data/evaluations/runtime-scenarios-deterministic.json` 和 `.data/evaluations/runtime-scenarios-real-model.json`；协议与扩展方式见 [`scenarios/runtime/README.md`](./scenarios/runtime/README.md)。

单独验证会话上下文驱动的智能 operation 路由。确定性模式使用 fixture 分类器和 fake 业务后端；真实模式只让 Intent Router 经过真实 GatewayClient，聊天和图片执行仍为 fake，避免把语义识别与图片模型成功率混在一起：

```bash
npm run eval:runtime-routing:deterministic
npm run eval:runtime-routing:real -- --model <fixed-model-alias>
```

报告分别写入 `.data/evaluations/runtime-routing-deterministic.json` 和 `.data/evaluations/runtime-routing-real-model.json`。核心指标包括 operation、源图片引用与实际字节、视觉模型图片输入、编辑 Prompt 历史、路由证据、活动图片和错误图片副作用率；真实有效分类样本少于 30 时固定标记为 `observation-only`。

只检查全局架构边界：

```bash
npm run test:architecture
```

只验证 C2 图片生成/编辑调用、上传与结果校验、资产落存、权限、幂等、取消和超时边界：

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

- `gpt-5.6` 和 `gpt-image-2` 是当前 LiteLLM 对话/编辑与图片生成模型别名；Runtime 通过 `LITELLM_MODEL`、`LITELLM_IMAGE_MODEL` 和 `LITELLM_IMAGE_EDIT_MODEL` 分别选择对话、图片生成与 Responses 图片编辑模型，浏览器和普通业务客户端不接触真实上游配置。
- `model_list[].litellm_params.model` 是 LiteLLM 转发给中转站的真实模型名。中转站是 OpenAI-compatible 时，通常保留 `openai/` 前缀。
- `UPSTREAM_API_BASE` 通常要带 `/v1`。
- `UPSTREAM_API_KEY1` 和 `UPSTREAM_API_KEY2` 分别是当前对话、图片模型的上游真实 key，只应放在服务端 `.env`。
- `LITELLM_MASTER_KEY` 是 Runtime 和模型连通性诊断访问内部模型网关的服务端凭据，不提供给浏览器或普通业务客户端；部署前请改成强随机值。
- `LITELLM_BASE_URL` 是 Runtime 使用的 LiteLLM Proxy 根地址，默认 `http://localhost:4000`，不要追加 `/v1`。
- `LITELLM_MODEL` 是 Runtime 请求的对话模型别名；当前示例配置为 `gpt-5.6`。
- `LITELLM_IMAGE_MODEL` 是 Runtime 请求的图片生成模型别名；当前示例配置为 `gpt-image-2`，必须与 `config.yaml` 的图片 `model_name` 完全一致。
- `LITELLM_IMAGE_EDIT_MODEL` 是 Runtime 经 `/v1/responses` 请求图片编辑的主线模型别名；当前示例配置为 `gpt-5.6`，未配置时回退 `LITELLM_MODEL`。
- `LITELLM_CHAT_MODELS`、`LITELLM_VISION_MODELS` 与 `LITELLM_IMAGE_EDITING_MODELS` 是逗号分隔的服务端能力别名；前两者未配置时回退 `LITELLM_MODEL`，编辑能力未配置时回退 `LITELLM_IMAGE_EDIT_MODEL`。含图片对话必须同时属于 `chat` 与 `vision`，图片生成固定使用 `LITELLM_IMAGE_MODEL`，图片编辑模型还必须属于 `imageEditing` 能力集合。
- `DEMO_DATABASE_PATH` 是 Runtime SQLite 文件，默认 `.data/ai-platform.sqlite`。
- `DEMO_IMAGE_ASSET_DIR` 是开发阶段图片二进制目录，默认 `.data/image-assets`；SQLite 只保存资产元数据和引用。
- `DEMO_CONTEXT_HIGH_WATERMARK_RATIO`、`DEMO_CONTEXT_LOW_WATERMARK_RATIO` 和 `DEMO_CONTEXT_HARD_WATERMARK_RATIO` 控制压缩水位。
- `DEMO_RUN_TIMEOUT_MS` 是排队、上下文规划和全部模型尝试共享的 Run 总时限，默认 `120000` 毫秒。
- `DEMO_MODEL_MAX_ATTEMPTS` 默认 `3`，包含首次调用；退避由 `DEMO_MODEL_RETRY_BASE_DELAY_MS` 和 `DEMO_MODEL_RETRY_MAX_DELAY_MS` 控制。
- `DEMO_TOOL_MAX_STEPS` 默认 `4`，限制一次 Run 内 `ToolLoopAgent`（或动态结构化特殊路径）的模型步骤；`DEMO_WEATHER_TOOL_ENABLED` 默认启用首个只读天气工具。
- `DEMO_WEATHER_TIMEOUT_MS` 默认 `8000` 毫秒；天气 Connector 只访问代码内固定的 Open-Meteo Geocoding 与 Forecast HTTPS 端点，不接受渠道或模型传入 URL。
- 当前输入包含明确地点且查询今天或明天天气时，服务端 Registry 会通过 AI SDK `prepareStep` 把首步确定性路由到 `get_weather`，后续步骤恢复 `auto`；缺少地点或超出日期范围时仍由模型澄清，不把任意文本转换为外部请求。
- 工具结果落库后若后续模型步骤失败且尚未向渠道交付正文，Runtime 会从 SQLite ToolResult 构造 AI SDK 结构化工具消息并发起无工具总结恢复，不会再次执行 Connector。Demo Server 重启时也会恢复满足资格的原 Run，但只覆盖 completed 只读 ToolResult 后的最终总结；未过期 lease 会阻止提前接管，过期后可用更大的 fencing token 接管。运行中工具、图片、写操作和超时 Run 仍不恢复；共享生产数据库部署、跨实例取消路由和生产级协调演练尚未完成。
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
| 架构图模块、关联、边界、路径摘要和 SVG/PNG 风格 | `docs/architecture-diagram-style.md` |
| 共同底座边界、重试与恢复策略、七条场景链路、当前 C1 焦点、质量指标和建设顺序 | `docs/scenario-interaction-chains.md` |
| Phoenix ChainTrace TODO 的触发条件与阶段决策 | `docs/decisions/2026-07-30-c1-chaintrace-runtime-validation-deferral.md` |
| Phoenix ChainTrace 启用、认证、健康检查、备份与升级边界 | `docs/c1-chaintrace-operations.md` |
| V1 只读工具循环、天气 Connector 和 LiteLLM digest 决策 | `docs/decisions/2026-07-30-v1-read-only-tool-loop-and-weather.md` |
| ToolResult 持久化总结恢复决策 | `docs/decisions/2026-07-31-tool-result-summary-recovery.md` |
| 首期可恢复执行、AcceptanceResult 和成熟引擎重评边界 | `docs/decisions/2026-08-13-durable-run-recovery-and-acceptance.md` |
| R0-R4 执行可靠性、A0-A4 结果可信度和场景扩展模板 | `docs/runtime-reliability-and-acceptance.md` |
| AI SDK Core v7 当前采用、延后与不采用的 API 边界 | `docs/ai-sdk-core-alignment.md` |
| C2 图片理解与生成的场景归属、模型调用和资产边界 | `docs/decisions/2026-07-31-c2-image-understanding-and-generation-boundary.md` |
| Runtime 智能默认 operation 的附件矩阵、置信度和恢复边界 | `docs/decisions/2026-08-02-runtime-smart-operation-routing.md` |
| C2 多轮图片编辑采用 Responses 图片工具的协议、资产和权限边界 | `docs/decisions/2026-08-02-c2-multi-turn-image-editing-responses-path.md` |
| C2 单图编辑 AI SDK `/images/edits` 历史路径 | `docs/decisions/2026-07-31-c2-image-editing-ai-sdk-path.md` |
| 会话、结构化记忆、上下文规划、并发和评测 | `docs/context-management.md` |
| 函数注释、数据结构、设计模式和设计原则 | `docs/coding-standards.md` |
| 项目级技术约定 | `openspec/project.md` |
| 平台当前集成切片、Demo API、鉴权、模型别名、上下文预算等稳定契约 | `openspec/specs/ai-platform/spec.md` |

Skill 相关内容统一放在 `.agents/skills/`，并遵守 `https://gitlab.seakoi.net/seakoi/skills` 仓库的指南、要求、原则。修改 Skill 后可运行 `node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs` 校验目录与 frontmatter。修改代理行为、Demo API、鉴权、模型别名或上下文预算时，需要同步 OpenSpec；只调整启动说明、示例命令或文案时，通常更新 README 或 docs 即可。

## 后续升级方向

当前保持单仓和轻量部署，先稳定区域接口，再按跨项目复用、独立安全边界、独立扩缩容或团队所有权逐个拆成服务：

1. V1：已适配 AI SDK Core `generateText` / `streamText` 的有界多步工具能力，以 Open-Meteo 跑通只读工具闭环、进程重启后受限 ToolResult 总结恢复和 A3 领域验收，并落地 SQLite RunLease/fencing 协调基础；真实模型天气质量、生产多实例部署与跨实例取消、更多业务 Connector、人工确认和写操作恢复仍未完成。
2. V2：把 LiteLLM 模型网关补成团队共享服务，增加 virtual key、多模型路由、fallback、预算、限流和调用统计。
3. V3：按资源和权限边界拆出连接器服务与知识服务。
4. V4：建设平台控制面和多渠道 Adapter，复用已经稳定的 Runtime、连接器和模型网关。
5. 治理与可观测贯穿所有阶段，通过统一身份上下文和事件结构接入，不成为同步调用单点。

区域定义、依赖规则、数据所有权、服务拆分条件和 V0.5-V4 实施对比见 `docs/ai-structure.md`。

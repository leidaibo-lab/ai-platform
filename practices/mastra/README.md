# Mastra 原生应用实践

2026-11-02：已建立独立可执行应用，跑通原生 Agent、只读工具、Studio/API，以及四阶段交接的暂停、确认、拒绝和跨进程恢复。当前验证使用官方 Mock 模型；真实模型质量、真实代码执行、多人权限和生产部署尚未验证。

2026-11-03 补充：使用本地配置的真实网关与密钥，已通过最小 Agent 的 generate、stream 及实际 `practiceInfo` 工具调用，并生成一份真实需求的产品文档，Workflow 停在 `review-product` 等待人工确认。该结果证明当前配置下的调用与首阶段交接可用；四阶段真实提案质量、真实代码执行、多人权限和生产部署仍未验收。

2026-11-04 补充：产品 Agent 显式挂载 `product-requirements-handoff` Skill；真实 `generate` 的 `toolResults` 观察到一次 `skill` 工具调用。相同需求的第一轮对比发现 Agent 重复询问输入中已明确的 Unicode 码点口径；Skill 已加入“已给定口径不重问”和补充平面／组合字符验收检查。更新后真实 `product-delivery` Workflow 又生成 `model-proposal`，并在产品审阅点 `review-product` 暂停。生成内容保留了已确认码点规则，增加补充平面及组合字符用例，并把空白字符与失败交互留为未决项。该观察证明方法可被实际读取且本次输出出现针对性改进，不代表该 Skill 对其他需求总能被遵循或完整真实模型质量已经验收。

本实践是[应用实践集合](../README.md)的首个可运行条目，使用 Mastra 自己的模型、Agent、Workflow 和 LibSQLStore，不导入探索主线 Runtime、Store、GatewayClient 或实验 Adapter。学习目标是理解原生设计，再比较差异，不是接入或替换探索实现。

## 产品交接物审阅页

2026-11-04 本机续验：产品阶段最小闭环已跑通；已完成真实模型需求生成、页面两轮问答、修订应用及用户产品确认，开发提案已生成并等待开发确认。交接就绪检查、内容质量和间歇流失败仍待完善。本次环境、验证证据和复评项见[产品阶段检查](./product-stage-review.md)。

2026-11-04：增加面向产品负责人的业务页面：分页 Run 列表、原样 Markdown 正文与下载、原始需求、版本标识、产品审阅记录、确认/拒绝二次确认、只读阅读助手，以及“明确结论 → 修订提案 → 差异预览 → 应用新轮次”。前端采用 Vercel AI SDK React、AI Elements 源码组件与 Streamdown；后端通过 Mastra 原生自定义路由读取快照和恢复流程。范围、接口与选型见[审阅页说明](./review-page.md)，组件来源见[第三方声明](./web/THIRD_PARTY_NOTICES.md)。

后端与前端分别保持一个终端运行；使用 Node.js 24+：

```bash
cd /Users/Administrator/self-code/ai-platform/practices/mastra
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix web ci --ignore-scripts --no-audit --no-fund

# 终端一：若 Studio 已在运行，保持原进程即可，不重复启动。
# 阅读已有 live Run 时，使用创建时相同的模式和数据目录。
MASTRA_MODE=live MASTRA_DATA_DIR=.data/live npm run dev

# 终端二：前端只代理本机 API，不加载服务端 .env 或持有模型密钥。
npm run review:dev
```

打开 [产品交接物审阅页](http://127.0.0.1:4112/)。先选择一条记录阅读正文，再向右侧助手提问；发现未决问题时，在助手下方填写你已经确认的结论，生成修订提案，查看逐行差异和完整新稿，填写应用人后应用并创建新轮次。需要作出产品决定时，在正文下方填写审阅人和意见，点击确认或拒绝并二次确认。可用 `?run=实际runId&proposal=提案Id` 直接打开记录和提案预览。当前已结束或进入下游的产品稿可以只读查看或另起修订，只有产品暂停点能提交决定；新建流程和后续开发/测试/运维确认继续使用 Studio 或 CLI。

无密钥体验可将后端命令换成 `MASTRA_MODE=fixture MASTRA_DATA_DIR=.data/review-fixture npm run dev`，再用相同模式、目录执行 `npm run delivery -- start '工单标题校验'`。固定样例不会理解新需求，阅读助手也只返回固定文字，页面有明确标签。

`npm run review:build` 进行前端类型检查和打包，`npm run review:preview` 在同一端口预览构建结果，仍需 4111 后端。代理目标和 Studio 链接当前固定为 `127.0.0.1:4111`。审阅人只是本地标签；本切片未接入真实用户认证。只读助手对话仅在当前页面保留，使用服务端配置的模型；live 提问会产生模型调用，但不会修改正文、审阅意见或流程决定。

## 先运行最小应用

环境要求：Node.js 24+。本次实测 Node `24.19.0`、npm `11.17.0`；安装和 npm 子进程都使用 Node 24，避免只有终端 node 是 24、实际 npm 子进程仍是 20 的情况。

```bash
cd /Users/Administrator/self-code/ai-platform/practices/mastra
# 如使用 nvm，先执行 nvm use 24
node --version
npm exec -- node --version
npm ci --ignore-scripts --no-audit --no-fund
npm run smoke
npm run dev
```

`npm run dev` 是前台常驻服务，体验 Studio 时需保持该进程运行；在对应终端按 Ctrl+C 才会停止。smoke、test 和 build 完成后不会持续提供 Studio 服务。若页面出现 “Failed to load studio”，先检查 `http://127.0.0.1:4111/api/agents` 是否可访问；连接被拒绝时重新启动 dev，再刷新页面。

如果接口已返回 HTTP 200，但 Studio 仍提示无法连接 `http://127.0.0.1:4111`，将浏览器地址统一为 `http://127.0.0.1:4111`，避免页面使用 `localhost`、连接目标却使用 `127.0.0.1`。2026-11-03 内置浏览器出现过这一现象，统一地址后 Agent 列表恢复，无需重启服务或重填密钥；尚未定位到具体浏览器限制。

默认 `fixture` 模式，无需密钥，不请求外部模型。打开 `http://127.0.0.1:4111`，在 Studio 的 Agents 中选择 `minimal-agent`，输入“调用 practiceInfo，说明本实践范围”。原生工具返回框架名称、学习范围及 `deploymentExecuted: false`，Agent 随后输出终答。generate 和 Studio 使用的 stream 都经过测试。

fixture 替换的只有模型响应，Agent、工具调度、Workflow、暂停恢复和数据库仍是真实 Mastra 实现。最小 Agent 根据真实工具结果是否进入上下文决定后续回复，不通过脚本直接调用工具来假装成功。fixture 的内容和 token 用量均为固定测试数据，不能评价模型智能、成本或质量。

Studio/API 仅绑定 `127.0.0.1`，是无登录的本地学习入口，不应直接暴露到公网。当前没有配置 Trace 后端，Studio 可用不等于完整可观测验收通过。dev/build 命令关闭 CLI telemetry。

## 原生目录与职责

```text
src/mastra/index.ts              Mastra CLI / Studio 原生导出入口
src/mastra/app.ts                Agent、Workflow、LibSQLStore 注册
src/mastra/config.ts             本实践配置与绝对数据库路径
src/mastra/agents/               最小助手、四个交接助手和只读阅读助手
src/mastra/tools/                无外部副作用的 practiceInfo
src/mastra/workflows/delivery.ts 原生步骤、暂停、恢复和交接数据 schema
src/delivery-service.ts          CLI/页面共享的交接与恢复服务
src/review-service.ts            产品文档投影、版本与输入校验
src/review-routes.ts             Mastra 原生 HTTP Adapter 与 AI SDK 流
web/                            独立 React/Vite 审阅页，不持有模型密钥
.agents/skills/                  Codex 与 Mastra Agent 共用的可审查 Skill 来源
scripts/                        smoke 与人工交接 CLI
tests/native.test.ts            原生执行及恢复回归
tests/review.test.ts             页面 API、决定边界与 SDK 多轮流回归
```

最小调用由 Studio/API 或脚本进入注册的 Agent，Agent 使用模型并执行 createTool 定义的工具。交接任务由 `createWorkflow().then(...).commit()` 推进，每个生成步骤调用对应 Agent，每个确认步骤使用 suspend/resume。执行快照和恢复由 LibSQLStore 持有，默认文件为本目录 `.data/mastra.db`，不使用探索 SQLite。

本切片没有配置 Agent Memory，因此不承诺聊天记忆持久化。持久化验证针对 Workflow 暂停快照及其中的交接物、确认记录，不将注册 storage 等同于所有 Agent 消息自动持久保存。

## 产品角色提示词和 Skill

系统提示词定义产品 Agent 每次执行都必须遵守的角色、事实边界和交付要求，维护在 `src/mastra/agents/index.ts` 的 `instructions.product`。可复用的需求拆解和验收方法维护在仓库 `.agents/skills/product/requirements-handoff/SKILL.md`，应用启动时通过 Mastra `validateSkillContent` 解析成 `createSkill()` 内联 Skill，再以原生 `skills` 配置挂给 Agent。这样文件继续遵守本仓库的两级目录命名，Mastra 也能使用原生 Skill 发现和读取工具。产品 Skill 加载后，模型生成该产品交接物时最多执行三步，以容纳 Skill 工具调用与终答；其他阶段继续使用原来的一步限制。

注册 Skill 不代表模型一定读取或遵循。产品步骤的运行证据应检查真实 `toolResults` 中是否包含 `skill`，再审查最终文档；自动测试同时检查 Agent 是否能列出和读取此 Skill，以及工作流仍在产品确认暂停点。真实模型对比发现用户明确给出的 Unicode 码点规则仍可能被重复询问，因此 Skill 增补了“已明确约束不重新作为未决问题”的方法和对应字符验收要求。扩展其他角色时，按需建立对应 Skill 并只挂载给负责的 Agent，不要把所有角色方法塞入一份共享长提示词。角色说明或 Skill 提供行为指导；必须保证的审批、版本和授权条件仍应由 Workflow 或代码校验，不依靠模型自觉。

开发 Agent 另挂载 `development-implementation-handoff` Skill，负责把已确认规则和验收条件映射到实现行为、变更范围及验证计划，并区分项目事实、假设和待确认项。由于当前交接输入没有仓库源码、开发 Agent 没有代码读写或命令执行工具，它不得编造路径、命令或声称检查通过；输出仍是待开发负责人确认的提案。开发 Skill 加载后，开发步骤最多执行三步，为 Skill 工具调用和最终提案留出空间。此改动提升提案方法，不构成真实代码生成或代码质量验证证据。

## 再运行产研交接

本轮实现的是**交接提案和人工确认**：产品文档 → 产品确认 → 代码提案 → 开发确认 → 测试计划 → 测试确认 → 部署方案 → 运维确认。确认当前交接物后才生成下一份；任一阶段拒绝立即结束本轮。

| 阶段 / CLI role | Agent 提供的交接物 | 人工确认责任 | 当前未执行的工程动作 |
| --- | --- | --- | --- |
| 产品 `product` | 需求、范围、验收条件 | 当前需求版本可交接 | 外部需求系统同步 |
| 开发 `development` | 代码提案、检查命令与风险 | 提案符合需求，质量检查还缺什么 | 写仓库、建分支、构建、代码质量检查 |
| 测试 `testing` | 需求—用例映射、边界及异常计划 | 用例覆盖与执行前提 | 执行生成的测试、采集真实测试报告 |
| 运维 `operations` | 环境前提、发布、验证和回滚方案 | 方案可实施，前提已明确 | 构建制品、预发验证、实际发布与回滚 |

fixture 始终返回“工单标题去首尾空格后为 1–80 字符”的固定样例，即使传入其他需求也不会理解新需求。真实需求推理需切换 live；交接物分别标记 `fixture` / `model-proposal`，两者都不能证明工程动作已执行。

```bash
# 返回 runId、待审角色、完整内容和 hash，第一步等待产品确认。
npm run delivery -- start '工单标题去首尾空格后为 1–80 字符'

# 将返回的 runId 和当前 artifact.hash 填入变量。
RUN_ID='实际的 runId'
HASH='当前待审交接物的 hash'
npm run delivery -- status "$RUN_ID"
npm run delivery -- review "$RUN_ID" product "$HASH" approve local-product '确认当前需求样例'

# 后续依次使用 development → testing → operations。
# 每次重新读取当前正文及 hash，再确认，不能复用旧 hash。
# 例如开发阶段拒绝（先把 HASH 更新为开发交接物的当前 hash）：
npm run delivery -- review "$RUN_ID" development "$HASH" reject local-developer '需要补充错误处理'
```

`reviewer` 是本地声明的审阅人标签，示例只是角色模拟。当前没有账号认证、指派、RBAC 或多人权限隔离，不将角色字符串校验称为真实权限验证。

交接物由阶段、需求、全部上游交接物及当前正文的 SHA-256 绑定。确认记录保存角色、hash、approve/reject、审阅人和说明；步骤返回新对象和新数组。评论只留审阅说明，不会修改批准内容；需求或正文有变化时拒绝本轮并发起新 Run。当前没有同一 Run 内编辑、重做、版本分支或自动失效传播。

终态同时查看框架 status 和业务 `result.outcome`：

- `plan-approved`：四份提案经过本地确认，**没有执行部署**。
- `rejected`：已拒绝，后续阶段没有生成。本次锁定版本的 bail 通过框架终态结束，不能仅凭框架 success 判断业务通过。
- `failed`：框架或生成步骤失败，不能视为业务批准。

status/review 命令每次都是新进程，通过同一数据库和 `createRun({ runId })` 恢复。CLI 在 resume 前拒绝错误角色、旧 hash、空审阅人、重复确认及模型模式变化，保留原暂停点。直接从 Studio/API 提交非法 resume 仍被步骤校验阻止，但可能使 Run 进入 failed；当前未提供修复失败 Run 的管理流程。

只支持本地串行操作，未验证多人并发、跨实例竞争、防篡改审计、运行中崩溃恢复、外部副作用 exactly-once 或升级后的旧快照迁移。“暂停后退出进程可恢复”不代表这些能力通过。

## 配置真实模型

只在本目录创建自己的 `.env`，不复制仓库根目录密钥；`.env.example` 是无真实凭据的样例。

| 配置 | 默认 / 要求 |
| --- | --- |
| `MASTRA_MODE` | fixture；明确设置 live 才使用远程模型 |
| `OPENAI_API_KEY` | live 必填；fixture 不使用 |
| `MASTRA_MODEL` | openai/gpt-4o-mini，可改为有访问权限的 openai/模型名；默认值只是样例，未验证账号可用性 |
| `MASTRA_BASE_URL` | 可选 OpenAI-compatible API 地址；留空使用原生 provider 默认地址 |
| `MASTRA_PORT` | 4111，仅绑定本机 |
| `MASTRA_DATA_DIR` | .data，相对本实践根目录，也支持绝对路径 |

配置来自进程环境和本实践 .env，显式进程变量优先。源码和本机构建输出均使用实践根目录的绝对数据库路径；复制 `.mastra/output` 到新环境前需重新确认路径、配置加载和持久卷，本次未作容器部署验收。

```bash
# 配置自己的 API key 和实际模型后：
npm run smoke:live
MASTRA_MODE=live npm run delivery -- start '你的真实需求'
MASTRA_MODE=live npm run dev
```

live smoke 会产生真实调用费用，要求同时观察非空终答与实际工具结果。恢复已有 Run 必须使用创建时的 fixture/live 模式；不能换成 fixture 把同一 Run 伪装成真实结果。

### 通过 input.codes 进行第一次真实实践

在本实践自己的 `.env` 中填写 `OPENAI_API_KEY`，不要将密钥发送到聊天中。其余配置可从下面的无密钥示例开始：

```dotenv
# 暂时保留默认样例；通过启动命令显式启用 live。
MASTRA_MODE=fixture
OPENAI_API_KEY=
MASTRA_BASE_URL=https://input.codes/v1
# 待核实：只有网关的实际 API model ID 为 gpt-6-astra 时才使用此值。
MASTRA_MODEL=openai/gpt-6-astra
MASTRA_PORT=4111
MASTRA_DATA_DIR=.data
```

`gpt6 astra` 是当前提供的模型展示名称，尚未确认其 API model ID。请从网关控制台复制准确 ID，并在前面添加 `openai/`；这个前缀用于 Mastra provider 路由，不应重复添加。2026-11-02 未认证访问 `https://input.codes/v1/models` 返回 `401 API_KEY_REQUIRED`，只能说明该接口要求鉴权，不能据此确认模型存在、账号权限或工具调用兼容性。

本次锁定的 Mastra 原生模型配置在提供自定义 `url` 时默认使用 Chat Completions，将向该基址下的 `/chat/completions` 发送请求。不要在 `MASTRA_BASE_URL` 后重复添加这个接口路径。如果网关模型只提供 Responses API，需要先确认，再将原生模型配置切换为 `api: 'responses'`；本轮没有验证该网关的生成接口或切换协议。

填好密钥并确认模型 ID 后，先在独立数据目录验证最小助手：

```bash
cd /Users/Administrator/self-code/ai-platform/practices/mastra
# 使用 Node.js 24+；smoke:live 显式启用真实调用。
MASTRA_DATA_DIR=.data/live npm run smoke:live
```

成功标准为输出 `mode: "live"`、非空模型终答及 `practiceInfo` 的实际工具结果。失败时先核对密钥权限、模型 ID、完整 API 基址和 Chat Completions 工具调用支持，不应将失败包装成样例成功。

通过后，先在原 dev 终端按 Ctrl+C 停止样例服务，再启动真实模式 Studio。同一个项目目录只允许一个 Mastra dev 实例，改变端口也不能绕过该限制；样例数据仍保留在 `.data/mastra.db`，真实实践使用独立的 `.data/live/mastra.db`：

```bash
MASTRA_MODE=live MASTRA_PORT=4111 MASTRA_DATA_DIR=.data/live npm run dev
```

打开 `http://127.0.0.1:4111`，先在最小助手里验证工具调用，再在 Workflow 中新建一份真实需求。建议用“工单标题去首尾空格后须为 1–80 字符，非法输入提示原因”的小需求，逐阶段检查产品验收条件、代码提案、测试覆盖和部署前提；每次只确认当前交接物。新建 live Run，不恢复旧 fixture Run。当前产出仍是待人工确认的提案，实际修改仓库、执行测试和部署需要后续单独接入执行环境。

## 验证证据

2026-11-02 锁定版本：`@mastra/core 1.81.0`、`@mastra/libsql 1.28.0`、CLI `mastra 1.37.0`、`zod 4.4.3`、`TypeScript 7.0.2`、`tsx 4.23.15`。独立 package/lockfile 不改变根目录依赖。

```bash
npm run check
npm test
npm run smoke
npm run build
npm start
```

- TypeScript 检查通过；原生回归 **8/8**：generate 工具调用、四阶段正常确认、错误角色/旧版本/空审阅人/重复确认、拒绝阻断、直接 resume 最终校验、stream 工具调用、无效需求/不存在 Run、OS 进程退出后恢复及模式切换拒绝。
- smoke：非空终答和一条 practiceInfo 实际 ToolResult。
- mastra dev：Studio HTML、`/api/agents` 和 `/api/workflows` 均 HTTP 200，注册五个 Agent 和一个 Workflow。
- mastra build 成功；构建服务器通过原生 API 完成 Agent generate，并启动 Workflow。服务器退出后，独立 CLI 从同一数据库读取到 review-product 暂停快照。构建版 HTTP stream 返回 200，流中观察到工具结果和 fixture 终答。
- smoke:live：配置预检按预期报告缺少 OPENAI_API_KEY，退出码 1；未调用真实模型，不报告模型质量或费用验证通过。
- 数据库、构建产物与依赖均忽略；验收启动的临时服务检查后停止。
- 仓库边界检查：现有架构回归 7/7、OpenSpec strict 1/1 通过；13 份相关 Markdown 的 92 个相对文件引用无缺失，git diff --check 通过。

自动回归实际执行的是本应用的测试，不是 Agent 生成的代码或测试计划。真实模型调用、生成内容质量、完整产研工程闭环和生产验收仍分别需要证据。

2026-11-04 审阅页补充：当前自动回归为 **16/16**，新增页面 API、修订提案持久预览、旧版本/非法决定保留暂停点、同进程并发决定/应用、拒绝历史、旧稿不变、重试幂等及官方 AI SDK transport 两轮流；前后端类型检查、前端打包和隔离副本 Mastra build 通过。浏览器已验证真实文档阅读、真实助手连续问答，以及隔离 fixture 数据中的修订差异、刷新恢复、取消/批准/拒绝交互；未审批用户已有真实 Run。详细证据和未验收边界见[审阅页验收](./review-page.md#2026-11-04-实测结果)。

2026-11-03 真实调用补充：`smoke:live` 返回 `mode: live`、非空终答及一条实际 `practiceInfo` 工具结果；原生 stream 消费完整流后同样观察到终答及一条工具结果。真实标题校验需求生成非空产品文档，交接物为 `model-proposal`，Run `625575bb-f1c9-42d6-bad6-23c46263c1a3` 持久化为 `suspended` / `review-product`，未代替用户确认。完整首阶段快照保存在本地忽略目录 `.data/live/first-live-delivery.json`；不提交密钥、原始网关异常或运行数据库。这些结果补充上面的固定模型证据，不代表完整真实模型质量评测或工程交付通过。

## 和探索实现相比，先学到什么

| 差异 | 本次证据与收益 | 代价 / 适用边界 |
| --- | --- | --- |
| Workflow 拥有交接生命周期 | 直接使用步骤、暂停快照和恢复，无需先给探索 Chat Runtime 增加工单调度 | 依赖框架快照与步骤 schema，升级和失败恢复仍需单独验证 |
| Agent 与 Workflow 职责不同 | Agent 提供内容，Workflow 决定阶段与人工交接，Studio 可调试两者 | 创建几个 Agent 不等于完整协作产品；角色、版本和审阅规则由业务补齐 |
| 存储由框架域管理 | LibSQL 保存流程快照，已证明暂停后跨进程继续 | 不等于探索 Store 的 Run/ToolResult/AcceptanceResult、Lease/fencing 契约，也未验证 Agent Memory |
| 工程事实与提案分开 | 交接物标记证据模式，终态叫方案确认 | 代码写入、CI、Sandbox、认证和发布系统未接入，不能据此评价实际代码交付质量 |

探索实现的显式会话事实、天气结果验收和 lease/fencing 解决已有会话与受限工具执行问题；本应用的优势证据是交接流程可以直接用原生 Workflow 表达。双方验证场景和范围不同，此时不给整体可靠性或生产成熟度排名。

实践贡献者维护配置、提示词、交接 schema/hash、确认规则、CLI 和回归；Mastra 提供 Agent/工具循环、Workflow 与存储实现。工厂集中装配配置，原生 Pipeline 表达顺序交接；没有自研调度器或统一框架接口。输入校验在边界、生成与审阅分步骤、测试模型在模型边界替换，分别落实 KISS、单一职责和依赖隔离。

下一步通过产品审阅页阅读真实需求、检查验收覆盖并人工确认，再在 Studio 继续评估下游提案质量；有真实执行需求时再明确代码仓库、隔离环境、CI 证据和权限，逐项扩展。计划集成或迁移探索主线时，另走方案决策和 OpenSpec。

## 官方依据

本次使用官方指南及锁定包类型/实现核对 API；createTool.execute、Agent.generate/stream、createStep/createWorkflow、createRun/start/resume 和 LibSQLStore 均由实际运行验证。

- [Develop](https://mastra.ai/docs/develop)
- [Agents](https://mastra.ai/docs/agents/overview)
- [Workflows](https://mastra.ai/docs/workflows/overview)
- [Suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume)
- [Storage](https://mastra.ai/docs/server-db/storage)
- [源码与许可证](https://github.com/mastra-ai/mastra)
- [Mastra 与 AI SDK UI](https://mastra.ai/integrations/agentic-ui/ai-sdk-ui)
- [Mastra AI SDK 集成 API](https://mastra.ai/reference/ai-sdk/overview)
- [shadcn/ui AI Elements](https://ui.shadcn.com/docs/ai-elements)

官方 Mock 来自锁定包 `@mastra/core/test-utils/llm-mock`，只用于演示和确定性测试。当前不作生产采用或商业分发的许可结论。

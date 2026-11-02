# Mastra 原生应用实践

2026-11-02：已建立独立可执行应用，跑通原生 Agent、只读工具、Studio/API，以及四阶段交接的暂停、确认、拒绝和跨进程恢复。当前验证使用官方 Mock 模型；真实模型质量、真实代码执行、多人权限和生产部署尚未验证。

本实践是[应用实践集合](../README.md)的首个可运行条目，使用 Mastra 自己的模型、Agent、Workflow 和 LibSQLStore，不导入探索主线 Runtime、Store、GatewayClient 或实验 Adapter。学习目标是理解原生设计，再比较差异，不是接入或替换探索实现。

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

默认 `fixture` 模式，无需密钥，不请求外部模型。打开 `http://localhost:4111`，在 Studio 的 Agents 中选择 `minimal-agent`，输入“调用 practiceInfo，说明本实践范围”。原生工具返回框架名称、学习范围及 `deploymentExecuted: false`，Agent 随后输出终答。generate 和 Studio 使用的 stream 都经过测试。

fixture 替换的只有模型响应，Agent、工具调度、Workflow、暂停恢复和数据库仍是真实 Mastra 实现。最小 Agent 根据真实工具结果是否进入上下文决定后续回复，不通过脚本直接调用工具来假装成功。fixture 的内容和 token 用量均为固定测试数据，不能评价模型智能、成本或质量。

Studio/API 仅绑定 `127.0.0.1`，是无登录的本地学习入口，不应直接暴露到公网。当前没有配置 Trace 后端，Studio 可用不等于完整可观测验收通过。dev/build 命令关闭 CLI telemetry。

## 原生目录与职责

```text
src/mastra/index.ts              Mastra CLI / Studio 原生导出入口
src/mastra/app.ts                Agent、Workflow、LibSQLStore 注册
src/mastra/config.ts             本实践配置与绝对数据库路径
src/mastra/agents/               最小助手和四个交接助手
src/mastra/tools/                无外部副作用的 practiceInfo
src/mastra/workflows/delivery.ts 原生步骤、暂停、恢复和交接数据 schema
src/delivery-service.ts          CLI 输入预校验，读取原生快照
scripts/                        smoke 与人工交接 CLI
tests/native.test.ts            原生执行及恢复回归
```

最小调用由 Studio/API 或脚本进入注册的 Agent，Agent 使用模型并执行 createTool 定义的工具。交接任务由 `createWorkflow().then(...).commit()` 推进，每个生成步骤调用对应 Agent，每个确认步骤使用 suspend/resume。执行快照和恢复由 LibSQLStore 持有，默认文件为本目录 `.data/mastra.db`，不使用探索 SQLite。

本切片没有配置 Agent Memory，因此不承诺聊天记忆持久化。持久化验证针对 Workflow 暂停快照及其中的交接物、确认记录，不将注册 storage 等同于所有 Agent 消息自动持久保存。

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

通过后，在另一个终端启动真实模式 Studio，保留原有 4111 样例实例：

```bash
MASTRA_MODE=live MASTRA_PORT=4112 MASTRA_DATA_DIR=.data/live npm run dev
```

打开 `http://localhost:4112`，先在最小助手里验证工具调用，再在 Workflow 中新建一份真实需求。建议用“工单标题去首尾空格后须为 1–80 字符，非法输入提示原因”的小需求，逐阶段检查产品验收条件、代码提案、测试覆盖和部署前提；每次只确认当前交接物。新建 live Run，不恢复旧 fixture Run。当前产出仍是待人工确认的提案，实际修改仓库、执行测试和部署需要后续单独接入执行环境。

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

## 和探索实现相比，先学到什么

| 差异 | 本次证据与收益 | 代价 / 适用边界 |
| --- | --- | --- |
| Workflow 拥有交接生命周期 | 直接使用步骤、暂停快照和恢复，无需先给探索 Chat Runtime 增加工单调度 | 依赖框架快照与步骤 schema，升级和失败恢复仍需单独验证 |
| Agent 与 Workflow 职责不同 | Agent 提供内容，Workflow 决定阶段与人工交接，Studio 可调试两者 | 创建几个 Agent 不等于完整协作产品；角色、版本和审阅规则由业务补齐 |
| 存储由框架域管理 | LibSQL 保存流程快照，已证明暂停后跨进程继续 | 不等于探索 Store 的 Run/ToolResult/AcceptanceResult、Lease/fencing 契约，也未验证 Agent Memory |
| 工程事实与提案分开 | 交接物标记证据模式，终态叫方案确认 | 代码写入、CI、Sandbox、认证和发布系统未接入，不能据此评价实际代码交付质量 |

探索实现的显式会话事实、天气结果验收和 lease/fencing 解决已有会话与受限工具执行问题；本应用的优势证据是交接流程可以直接用原生 Workflow 表达。双方验证场景和范围不同，此时不给整体可靠性或生产成熟度排名。

实践贡献者维护配置、提示词、交接 schema/hash、确认规则、CLI 和回归；Mastra 提供 Agent/工具循环、Workflow 与存储实现。工厂集中装配配置，原生 Pipeline 表达顺序交接；没有自研调度器或统一框架接口。输入校验在边界、生成与审阅分步骤、测试模型在模型边界替换，分别落实 KISS、单一职责和依赖隔离。

下一步先配置真实模型，验证最小 Agent 和一份真实需求的四阶段提案质量；有真实执行需求时再明确代码仓库、隔离环境、CI 证据和权限，逐项扩展。计划集成或迁移探索主线时，另走方案决策和 OpenSpec。

## 官方依据

本次使用官方指南及锁定包类型/实现核对 API；createTool.execute、Agent.generate/stream、createStep/createWorkflow、createRun/start/resume 和 LibSQLStore 均由实际运行验证。

- [Develop](https://mastra.ai/docs/develop)
- [Agents](https://mastra.ai/docs/agents/overview)
- [Workflows](https://mastra.ai/docs/workflows/overview)
- [Suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume)
- [Storage](https://mastra.ai/docs/server-db/storage)
- [源码与许可证](https://github.com/mastra-ai/mastra)

官方 Mock 来自锁定包 `@mastra/core/test-utils/llm-mock`，只用于演示和确定性测试。当前不作生产采用或商业分发的许可结论。

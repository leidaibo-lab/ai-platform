# Mastra 原生应用实践

2026-11-02：已建立独立可执行应用，跑通原生 Agent、只读工具、Studio/API，以及四阶段交接的暂停、确认、拒绝和跨进程恢复。当前验证使用官方 Mock 模型；真实模型质量、真实代码执行、多人权限和生产部署尚未验证。

2026-11-03 补充：使用本地配置的真实网关与密钥，已通过最小 Agent 的 generate、stream 及实际 `practiceInfo` 工具调用，并生成一份真实需求的产品文档，Workflow 停在 `review-product` 等待人工确认。该结果证明当前配置下的调用与首阶段交接可用；四阶段真实提案质量、真实代码执行、多人权限和生产部署仍未验收。

2026-11-04 补充：产品 Agent 显式挂载 `product-requirements-handoff` Skill；真实 `generate` 的 `toolResults` 观察到一次 `skill` 工具调用。相同需求的第一轮对比发现 Agent 重复询问输入中已明确的 Unicode 码点口径；Skill 已加入“已给定口径不重问”和补充平面／组合字符验收检查。更新后真实 `product-delivery` Workflow 又生成 `model-proposal`，并在产品审阅点 `review-product` 暂停。生成内容保留了已确认码点规则，增加补充平面及组合字符用例，并把空白字符与失败交互留为未决项。该观察证明方法可被实际读取且本次输出出现针对性改进，不代表该 Skill 对其他需求总能被遵循或完整真实模型质量已经验收。

2026-11-06 补充：产品生成展开为总产品、需求梳理、产品闭环、产品写作四个固定 Agent 的原生子 Workflow；每个角色最多 24 步，可使用产品 Skill 和已注册只读工具。增加“退回修改”：保留旧稿和反馈，在独立新轮次重走四角色并重新等待人工验收，最多三次。自动回归 31/31、后端类型检查和前端构建通过；隔离浏览器已验证返工及新旧稿导航。角色产物、来源与人工操作见[产品固定角色子流程](./product-workflow.md)。本次验证控制流与版本边界，真实质量收益待对比。

本实践是[应用实践集合](../README.md)的首个可运行条目，使用 Mastra 自己的模型、Agent、Workflow 和 LibSQLStore，不导入探索主线 Runtime、Store、GatewayClient 或实验 Adapter。学习目标是理解原生设计，再比较差异，不是接入或替换探索实现。

## 项目 Workspace

[Workspace 使用说明](./workspaces.md)：Studio 中提供招聘业务资料、运行产物和评测结果三个只读视图。四个产品角色可实际读取 `sources/` 原始材料；新产品稿自动按 Run/hash 导出，人工确认仍由 Workflow 持有。支持历史稿件补导出和显式启用固定资料快照的配对评测，不提供代码执行或自动质量放行。

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

## 持续业务场景项目

为避免每次用彼此无关的临时需求验证单个 Agent，新增了[招聘管理工作流验证项目](./projects/pm-hrm-recruitment/README.md)。它以 `pm-hrm` 招聘模块为稳定场景，从[原始诉求](./projects/pm-hrm-recruitment/sources/brief.md)考查产品 Agent 自主梳理需求和生成产品稿，再推进人工确认及工程交付。2026-11-05 用户已选择首期初筛与邀约切片、预置合成数据及本地模拟角色；当前产品角色已接入只读业务资料；真实代码执行与测试能力尚未接入。

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

Studio/API 与交接 CLI 的共享应用装配已启用 Mastra 原生 `ConsoleLogger`，级别为 `info`，输出 info、warn、error 到进程的标准输出/错误。当前后台 Studio 的输出追加到 `.data/live/studio-dev.log`，可用 `tail -f .data/live/studio-dev.log` 实时查看；直接前台运行时在启动终端查看。日志文件由启动方式重定向产生，Logger 本身不负责写文件、轮转或在 Studio 中保存日志。框架错误可能带上游响应和业务输入，对外分享前需脱敏；历史失败不会因开启 Logger 自动补写。独立开发执行与产品 Skill 评测入口仍使用各自装配，不随此配置启用日志。

如果接口已返回 HTTP 200，但 Studio 仍提示无法连接 `http://127.0.0.1:4111`，将浏览器地址统一为 `http://127.0.0.1:4111`，避免页面使用 `localhost`、连接目标却使用 `127.0.0.1`。2026-11-03 内置浏览器出现过这一现象，统一地址后 Agent 列表恢复，无需重启服务或重填密钥；尚未定位到具体浏览器限制。

默认 `fixture` 模式，无需密钥，不请求外部模型。打开 `http://127.0.0.1:4111`，在 Studio 的 Agents 中选择 `minimal-agent`，输入“调用 practiceInfo，说明本实践范围”。原生工具返回框架名称、学习范围及 `deploymentExecuted: false`，Agent 随后输出终答。generate 和 Studio 使用的 stream 都经过测试。

fixture 替换的只有模型响应，Agent、工具调度、Workflow、暂停恢复和数据库仍是真实 Mastra 实现。最小 Agent 根据真实工具结果是否进入上下文决定后续回复，不通过脚本直接调用工具来假装成功。fixture 的内容和 token 用量均为固定测试数据，不能评价模型智能、成本或质量。

Studio/API 仅绑定 `127.0.0.1`，是无登录的本地学习入口，不应直接暴露到公网。当前没有配置 Trace 后端，Studio 可用不等于完整可观测验收通过。dev/build 命令关闭 CLI telemetry。

## 原生目录与职责

```text
src/mastra/index.ts              Mastra CLI / Studio 原生导出入口
src/mastra/app.ts                Agent、Workflow、LibSQLStore 注册
src/mastra/config.ts             本实践配置与绝对数据库路径
src/mastra/agents/               四个产品角色、三个下游交接助手、最小助手和阅读助手
src/mastra/tools/                无外部副作用的 practiceInfo
src/mastra/workflows/delivery.ts 原生步骤、暂停、恢复和交接数据 schema
src/mastra/workflows/product.ts  固定四角色原生子 Workflow，输出角色产物与最终产品稿
src/mastra/workflows/product-contract.ts 产品角色证据、返工来源与次数上限
src/delivery-service.ts          CLI/页面共享的交接与恢复服务
src/review-service.ts            产品文档投影、版本与输入校验
src/review-routes.ts             Mastra 原生 HTTP Adapter 与 AI SDK 流
web/                            独立 React/Vite 审阅页，不持有模型密钥
.agents/skills/                  Codex 与 Mastra Agent 共用的可审查 Skill 来源
scripts/                        smoke 与人工交接 CLI
tests/native.test.ts            原生执行及恢复回归
tests/review.test.ts             页面 API、决定边界与 SDK 多轮流回归
tests/product.test.ts            四角色、返工上限、故障隔离、进程恢复与旧暂停点兼容
```

最小调用由 Studio/API 或脚本进入注册的 Agent，Agent 使用模型并执行 createTool 定义的工具。交接任务由 `createWorkflow().then(...).commit()` 推进；产品生成是四角色子 Workflow，其他阶段生成步骤调用对应 Agent，每个确认步骤使用 suspend/resume。执行快照和恢复由 LibSQLStore 持有，默认文件为本目录 `.data/mastra.db`，不使用探索 SQLite。

本切片没有配置 Agent Memory，因此不承诺聊天记忆持久化。持久化验证针对 Workflow 暂停快照及其中的交接物、确认记录，不将注册 storage 等同于所有 Agent 消息自动持久保存。

## 产品角色提示词和 Skill

角色职责、中文名称与优先方法维护在 [product-roles.ts](./src/mastra/agents/product-roles.ts) 的 `productRoleProfiles`；共同任务、Skill 使用要求和事实边界维护在 `src/mastra/agents/index.ts` 的 `productTask`、`instructions.product`、`productBoundaries`。四个角色通过同一工厂挂载完整 113 项 Skill：总产品优先分诊/优先级/机会树，需求梳理优先请求归类/工作故事/访谈提纲，闭环优先测试场景/承重假设挑战/失败预演，写作优先 PRD/用户故事/WWA。优先方法是选择起点，角色仍可从全套选择更合适的方法；启动时检查优先方法是否真实注册。

原有 `productAgent` 保留注册名与 ID，承担文档写作和已有修订预览；另注册总产品、需求梳理、产品闭环三个 Agent。需求交接方法仍维护在仓库 `.agents/skills/product/requirements-handoff/SKILL.md`，通过原生 `validateSkillContent` / `createSkill()` 挂给四个角色；完整 PM 套件采用本实践独立管理的 Skill 目录，见文末说明。各角色执行和单写作修订预览共用每次最多 24 步的工具循环预算。角色按需调用 `skill` / `skill_read`，交付前做需求交接检查；中间角色交付各自分析，写作角色汇总完整稿。原文方法的跨角色流程只执行当前职责部分；需要补问的缺口保留给人工确认。应用修订稿时原样使用预览内容。

注册 Skill 不代表模型一定读取或遵循。产品步骤的运行证据应检查真实 `toolResults` 中是否包含 `skill`，再审查最终文档；自动测试分别检查四个角色能列出完整套件、实际读取对应方法与参考原文，以及工作流仍在产品确认暂停点。2026-11-06 角色融合后全套回归 **36/36** 通过，其中新增四项角色工具链与一项四角色 Workflow 集成验证；这是确定性模型驱动的工具与状态证据，尚未验证真实模型选法和内容质量。历史真实模型对比发现用户明确给出的 Unicode 码点规则仍可能被重复询问，因此需求交接 Skill 增补了“已明确约束不重新作为未决问题”的方法和对应字符验收要求。角色只常驻职责与选法指引，方法全文经工具按需读取。角色说明或 Skill 提供行为指导；必须保证的审批、版本和授权条件仍应由 Workflow 或代码校验，不依靠模型自觉。

开发 Agent 另挂载 `development-implementation-handoff` Skill，负责把已确认规则和验收条件映射到实现行为、变更范围及验证计划，并区分项目事实、假设和待确认项。由于当前交接输入没有仓库源码、开发 Agent 没有代码读写或命令执行工具，它不得编造路径、命令或声称检查通过；输出仍是待开发负责人确认的提案。开发 Skill 加载后，开发步骤最多执行三步，为 Skill 工具调用和最终提案留出空间。此改动提升提案方法，不构成真实代码生成或代码质量验证证据。

## 产品 Skill 效果对比

[配对评测说明](./evaluations/product-skills/README.md)固定模型、四角色、执行路径和原始需求，只切换完整 Skill 包及调用指引。执行 `npm run eval:product-skills` 验证管道，增加 `-- --live` 生成真实模型首稿；三个固定案例每组一次，共六份稿，停在产品人工验收。隔离数据库、控制变量、用量与匿名审阅稿保存在 `.data/evaluations/`。

人工填写遗漏、错误、首稿放行决定和主动审阅秒数后，用 `npm run eval:product-skills -- --report .data/evaluations/<run>` 汇总。未审为 null，失败单列；只有双方已审且响应模型一致的配对才计算人工差值。费用需要带来源的实际单价，没有单价时只报告 token。小样本只能观察，不能据此宣称 Skill 已提高通过率。

## 评测阶段 TODO：核查 Mastra 原生能力与选型

- [ ] 进入上下文与记忆质量评测阶段时，先核对当时锁定的 Mastra 版本、官方文档及安装包 API，验证多轮对话、记忆召回与事实更新、会话隔离、自定义断言／评分和结果记录的支持范围；区分默认可用、需显式配置、需额外依赖和需自行适配，不预设当前版本已支持。
- [ ] 用最小可复跑场景保存输入、预期结果、命令和实际输出，分别记录确定性回归与真实模型质量证据；对照仓库 `docs-context-memory-evaluation` 的场景与指标梳理覆盖和缺口，不直接复制探索主线 Runtime 或评测实现。
- [ ] 根据证据决定：原生满足则采用；少量业务断言可补齐则薄适配；关键能力缺失或适配成本过高则按[方案选型治理](../../docs/solution-selection-governance.md)重新比较成熟工具并记录决策，再决定引入依赖或补充实现。责任人为本实践维护者，完成标准是留下版本、验证证据、能力缺口和最终选择。

## 再运行产研交接

本期只建设产品确认后的开发阶段。独立 [development 入口](./development-workflow-design.md#开发执行入口)使用原生 Workflow 执行架构确认、按文件任务实现、真实开发自检、有界返工和研发交付包；首版为离线 Node ESM 受控切片。[能力评测](./evaluations/development/README.md)覆盖24案例，固定控制流、真实模型行为与人工质量评分分别报告；[2026-11-06 pilot 观察](./evaluations/development/observations-2026-11-06.md)保留48项原始结果、执行器缺陷及能力未准入结论。截图候选技术栈的整栈能力尚未验收。独立测试阶段不在本期范围内。

研发工作已按[续办TODO](./evaluations/development/observations-2026-11-06.md#v3复测中断与续办todo)恢复推进。恢复重放、执行身份、评测来源、错误分类及隐式重试缺口已修复，保留回归已激活，完整实践99/99通过。新v3全量48项为41交付、6澄清、1模型故障；整栈Agent已生成三文件候选，构建受Docker Hub token超时阻塞。完整证据见[续办记录](./evaluations/development/continuation-2026-11-06.md)。原v3中断记录保留；[主持全栈基准v4](./evaluations/development/full-stack/README.md#2026-11-06-主持基准实测)单独登记，不代表Agent能力通过。独立人评和能力准入仍未完成。

本轮实现的是**交接提案和人工确认**：产品文档 → 产品确认 → 代码提案 → 开发确认 → 测试计划 → 测试确认 → 部署方案 → 运维确认。确认当前交接物后才生成下一份；任一阶段拒绝立即结束本轮。

产品阶段还支持独立的 `rework` 决定：四角色带着原稿与意见产生返工新 Run，停在新的产品人工关口，旧批准不继承。`reject` 继续表示终止，后续开发/测试/运维不支持自动返工。API/CLI 返回新 `runId`，需要改用新 Run 和 hash 继续审阅。

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

# 产品稿需要修改时，用 rework 代替 approve；返回新 runId 和待审 hash。
# npm run delivery -- review "$RUN_ID" product "$HASH" rework local-product '补充失败反馈和对应验收'

# 后续依次使用 development → testing → operations。
# 每次重新读取当前正文及 hash，再确认，不能复用旧 hash。
# 例如开发阶段拒绝（先把 HASH 更新为开发交接物的当前 hash）：
npm run delivery -- review "$RUN_ID" development "$HASH" reject local-developer '需要补充错误处理'
```

`reviewer` 是本地声明的审阅人标签，示例只是角色模拟。当前没有账号认证、指派、RBAC 或多人权限隔离，不将角色字符串校验称为真实权限验证。

交接物由阶段、需求、全部上游交接物及当前正文的 SHA-256 绑定，产品另绑定角色产物及修订/返工来源。确认记录保存角色、hash、approve/reject/rework、审阅人和说明；步骤返回新对象和新数组。批准评论不修改正文；退回意见随新轮次传给四个角色，旧稿保持不变。当前没有同一 Run 内编辑、重做、版本分支或自动失效传播。

终态同时查看框架 status 和业务 `result.outcome`：

- `plan-approved`：四份提案经过本地确认，**没有执行部署**。
- `rejected`：已拒绝，后续阶段没有生成。本次锁定版本的 bail 通过框架终态结束，不能仅凭框架 success 判断业务通过。
- `rework-requested`：旧轮次已保存退回意见；后继新 Run 重新等待产品确认，来源稿只读。页面提供前后轮次导航，相同退回请求重试回读同一后继。
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

## 产品 PM 技能套件

[完整目录与维护说明](.agents/skills/README.md)：全量迁入 phuryn/pm-skills 的69个原子能力与42个流程命令，流程转换为 `product-pm-flow-*` Skill，另增1个本地导航。固定上游版本、许可证、原文与资源散列可在该目录审计，启动不访问上游。

产品角色共用113个原生 Skill（套件112项及原需求交接1项），按任务使用 `skill` 加载中文方法、`skill_read` 读取原文及分支资料、`skill_search` 搜索资源。产品默认、交付子流程和修订共享每次最多24步的有限预算；其他角色维持各自职责。模板与步骤提供方法，不代表获得搜索、SQL、文件、测试执行或发布权限；工作流中的人工确认继续绑定当前正文版本。

验证：在实践根运行 `npm run check`、`npm test`、`npm run smoke`、`npm run build`；仓库根运行 `node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs`。`tests/skills.test.ts` 校验全量库存与散列，并通过原生工具循环验证流程→原子方法→原文→嵌套资源。Mock结果仅证明可加载及控制流，真实产品质量、路由命中和成本需业务材料另验。

选型与作用域：[适配决策](../../docs/decisions/2026-11-06-mastra-pm-skills.md)。

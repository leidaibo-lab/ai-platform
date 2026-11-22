## 1. 已实施的阶段入口

- [x] 产品写作与独立审查使用阶段只读 Workspace，保留已授权业务资料和实际读取回执。
- [x] 测试计划通过只读 Workspace 读取候选，浏览器 QA 读取批准资产；交付通过只读 Workspace 核对候选、规格与 QA 证据。
- [x] Node/Python 研发固定检查使用候选 Workspace Sandbox；HRM/CIP 保留登记的 Docker 验证器。
- [x] 记录架构、数据流、工具边界和已验证范围；Mastra Store 继续持有审批及恢复事实。

## 2. 待完成：产品入口与恢复

- [x] 产品逐项澄清、研发阻塞问题生成及产品修订接入按 Run 绑定的只读 Workspace；授权材料包含冻结业务资料、固定项目规格、后继基线及经校验的 Git 交接文件，问题与草稿保存实际读取回执。
- [x] 适配产品 Agent 阶段重装配的故障注入；验证中止、重试、写作和审查恢复语义。
- [x] 修复产品 HTTP 专项认证与结构化输出重试用例，重新运行 guided-intake、blocker 和产品生成回归。
- [x] 实现历史挂起 Run 缺少或漂移 Sandbox 策略身份时的受控重新启动迁移。服务端准备计划，账号确认散列后创建带谱系的新 Run，继承调用消费预算并重新审批；验证 Store 重开、来源候选漂移拒绝及旧暂停点保持。

## 3. 待完成：全链路验证

- [ ] 补齐跨项目和跨 Run 资料隔离、产品读取回执、阶段身份及来源漂移拒绝的端到端验证。
- [ ] 验证交付阶段固定规格路径、权限边界与恢复语义；确认 fixture 和 live 的验证范围。
- [ ] 在受控环境独立验证 HRM/CIP Docker 检查、真实模型质量、浏览器 QA 和真实远端 MR；分别记录事实，不以 fixture 充当验收。
- [ ] 全部产品、研发、测试和交付入口及回归通过后，再认定本变更完成；更新运行文档和验证记录。

## 4. 已有验证记录（2026-11-22）

- [x] 类型检查、diff 格式检查通过；阶段 Workspace 隔离与只读专项 3 项通过。
- [x] 统一主链及恢复回归 20 项通过；Python Adapter 固定检查及 Node/Python 并发、跨 Store 恢复和错绑拒绝回归通过。
- [x] 研发执行与 Nacos 团队方法专项 13 项通过；浏览器使用宿主 Playwright，未宣称运行在 Workspace Sandbox。

## 5. 产品专项复验（2026-11-22）

- `npx tsx --test tests/guided-intake.test.ts tests/blocker-clarification.test.ts tests/product-generation.test.ts`：35 项通过，0 失败。原有 8 项失败均已复现并修复测试适配；本次范围为上述三个文件，不等同于此前 38 项组合或真实模型验收。

- Sandbox 身份定向验证：`npx tsx --test tests/blocker-clarification.test.ts tests/development-recovery-review.test.ts` 16 项通过；另以真实暂停载荷调用阻塞分析节点，验证缺失及旧策略在模型切换时被拒绝。已构造隔离持久化历史 Run 并验证拒绝恢复；尚未实现迁移。

- `npx tsx --test --test-name-pattern='缺少 Sandbox 身份' tests/development-state-flow.test.ts`：1 项通过；测试分别改造隔离 Store 中的父、子 Workflow 快照，重开后拒绝恢复且不改写暂停载荷。

- 阻塞修订 Workspace 专项：`npx tsx --test tests/blocker-clarification.test.ts tests/stage-workspace.test.ts` 11 项通过，覆盖原稿读取回执、缺回执拒绝发布并保留回答、历史恢复与只读隔离。其他澄清入口及 live 模型质量尚未验证。

- 产品、阻塞回流、Nacos 与统一主链组合回归：`npx tsx --test tests/guided-intake.test.ts tests/blocker-clarification.test.ts tests/unified-workflow.test.ts tests/nacos-resources.test.ts`，48 项通过。

- 全量离线回归：`npm test` 276 项通过、0 失败、0 取消，耗时约 283 秒；覆盖 fixture 与部分本地 HTTP 模拟，不代表真实模型、生产或真实远端 MR 验收。

- 后续逐项澄清改动：每轮使用 Run 只读 Workspace 读取需求，读取回执及内容散列进入暂停快照和版本散列；旧快照不增加字段时保持旧散列算法。该改动后的全量测试尚未运行。

## 最新实现与验证口径

前文“尚未实现迁移”“其他澄清入口未验证”为当时执行记录。当前已实现受控重新启动迁移、逐项澄清与阻塞生成的 Workspace 接入；迁移保持旧 Run 不变，新增 Run 记录谱系和已消费预算并重新经过人工审批。真实模型、真实 MR、Docker 全环境和生产验收仍未完成。

受限并发全量回归曾完成 297 项通过，耗时 495.5 秒；之后新增输入包及工具故障处理。更新后定向回归单独记录，不将前次全量通过套用到后续改动。

- 第二轮全量最终退出：301 项、300 通过、1 失败、0 取消，耗时 512.9 秒。唯一失败为 `failed-branch-evidence`，运行早期使用委派故障误分类实现；修正后包含该用例的最终定向 36 项全部通过。多项目路由已正常结束。本轮不宣称最新全量全部通过。

- 产品入口、阻塞澄清、产品生成、研发恢复与自治、平台接续和运行时间线定向组合曾有 88 项通过；类型检查与工作台构建通过。故障注入为隔离 fixture，不代表真实模型或生产验收。

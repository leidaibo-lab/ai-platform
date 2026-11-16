# 决策审计修复验证与证据登记

## 修复范围

日期：2026-10-12。依据 [原审计](./2026-10-12-architecture-decisions.md) D1-D8，完成已实现稳定契约同步、有效记录演进说明、索引补齐、模板升级、18 份有效记录的实施映射与本地验收清单，以及 14 个关键代码入口的 ADR 反向引用。3 份已替代记录保持历史内容和状态。

本轮对源代码仅新增模块入口注释，不修改函数、数据结构、配置值、数据库 schema 或业务行为。原有 Port/Adapter、Observer、Strategy 和 Store 所有权保持；未新增设计模式或通用基础设施。文档将现有实现与契约对齐，符合单一事实源、依赖倒置、KISS 和 YAGNI。修复采用复用项目已有 OpenSpec delta、模板和测试的方式，没有引入第三方校验框架、没有创建另一套 ADR 目录，也未归档 change。

## 当前可复核验证

执行环境：Node.js 24.19.0，项目 `ai-platform@0.6.0`；依赖按 lockfile 安装，AI SDK 7.0.37 / openai-compatible 3.0.14，Vite 6.4.3。完整原始运行日志为本轮临时输出；以下摘要只保留命令、规模和结果，后续按命令重新生成，不包含密钥或模型/业务正文。

| 验证 | 命令 | 结果与证据边界 |
| --- | --- | --- |
| 全量本地回归 | `npm test` | 165 tests，165 pass，0 fail/skip/cancel；配置、Runtime、Gateway、图片 fake、天气 Connector fake、Lease/Policy、SSE、场景、遥测和架构边界均在 package.json 套件内 |
| Demo 构建与资源 | `npm run demo:check` | 构建和预算通过；JS gzip 364.06 KiB，CSS gzip 7.05 KiB；不代表浏览器可访问性或下载落盘验收 |
| 记忆确定性链路 | `node .agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs` | `message-queue-correction-100`：100 轮、10/10 checkpoints、5/5 指标、100.0%；不代表真实模型质量 |
| 稳定契约 | `openspec validate --specs --strict` | `ai-platform` 严格校验通过；同时核对 Requirement 唯一与既有场景保留，不能仅凭语法通过声明语义一致 |
| Runtime key delta | `openspec validate integrate-runtime-virtual-key --strict` | 通过；组合任务 3.4 的 CLI/全量回归缺口补齐 |
| 恢复/验收 delta | `openspec validate add-durable-run-recovery-and-acceptance --strict` | 通过；completed 只读 ToolResult 恢复及 AcceptanceResult 事务契约已进入 stable spec |
| 执行治理 delta | `openspec validate add-execution-governance-foundation --strict` | 通过；Policy/Hook、Operation 和 RunLease/fencing 已进入 stable spec |
| Skill 结构 | `node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs` | 通过；本轮没有修改 Skill 的工作流或引入新脚本 |
| 文档和引用 | 本地 Markdown 链接、实施路径与 ADR 引用核对；`git diff --check` | 通过；21 份决策全部进入索引；18 份有效记录有带日期的实施/验收补充 |

本地验收复选框勾选仅代表以上套件和结构核对在本日完成，不能让历史真实外部证据自动变成当前验证。本地回归不覆盖第三方实际服务、上游账号可用性或生产多实例部署。

## 历史外部证据登记与补验任务

下表将原记录的陈述留作历史摘要，显式记录原始证据缺口和重新验证入口。没有可访问的原始脱敏报告时，不虚构恢复报告，不把历史 ID/hash 等同于可独立复核的运行证据。

| 证据/决策 | 仓库内可用资产 | 原始证据状态 | 补验任务、责任与门禁 |
| --- | --- | --- | --- |
| Phoenix/Langfuse 同 Trace 对比及 Phoenix 升级/回滚 | `scripts/run-chain-trace-backend-poc.mjs`、`docker-compose.chaintrace.yml`、`docs/c1-chaintrace-operations.md`，决策内版本、digest、Trace ID、备份 hash | 原终端/API 输出未作为版本化报告留存；本轮没有重跑 | 治理维护者在正式 Trace 触发时按运维说明执行认证、查询、备份/升级/恢复，保存脱敏版本/输入/结果摘要；当前延期有效 |
| LiteLLM virtual key、预算拒绝与真实 spend | `scripts/test-gateway-governance.mjs`、`scripts/provision-gateway-runtime-key.mjs`、`scripts/test-runtime-governance.mjs`、隔离 Compose/config | 历史 HTTP/数据库结果只有决策摘要；本轮未调用管理 API | 网关维护者在共享前验证固定版本许可证、零预算拒绝、最小权限、spend 对账和 Redis 多副本限流；真实调用需要显式配置和对应成本授权 |
| C2 文生图/Responses 连续编辑与兼容字段 | `src/gateway/responses-image-edit-adapter.mjs`、Gateway/Image fake 测试；决策保留历史输入尺寸、时间及结果摘要 | 历史图片/SQLite 原始资产未纳入本次审计；本轮无上游图片调用 | Runtime/网关维护者在映射、key 或版本变化后使用无业务信息的合成图片复核 edit/tool_choice/max_tool_calls 兼容和连续源版本；生产前补审核、计费、质量和对象存储 |
| 天气恢复真实模型 evaluation | `scenarios/runtime/weather-restart-accepted/`、`weather-restart-rejected/`、`scripts/run-runtime-scenarios.mjs` | 旧 `.data/evaluations/` 报告非版本化资产；原 0/1 超时保持失败观察 | Runtime/评测维护者在上游可用时以显式模型、同 fixture/Prompt 参数重跑，保存脱敏报告；不少于 30 有效样本前保持 observation-only |
| 上下文图片路由真实 4 样本 | `scenarios/runtime-routing/image-context-continuation/`、`scripts/run-runtime-routing-scenarios.mjs` | 仅历史 4 样本摘要，不视为发布基线；现有版本化场景矩阵仍不足 | 评测维护者在发布前补无关聊天、新图、显式旧图、非法证据、跨会话和阈值负例 fixture；固定模型/schema/Prompt，不少于 30 有效分类样本，业务负责人定义 P95/成本阈值后验收 |
| Memory Provider 真实对照与 UI 浏览器验收 | 100 轮 fixture、记忆评测 Skill、Demo Adapter 与构建预算脚本 | 没有新增真实 Provider/浏览器证据；现有脚本通过不能替代 | 评测维护者按相同输入/来源指标执行 Provider Benchmark；渠道维护者复核桌面/移动/键盘及下载落盘；上线前明确目标，不由审计虚构阈值 |

### 明确未完成的发布门禁

- [ ] 模型网关：固定 LiteLLM 版本许可、图片计费、Redis 多实例和 provider 对账。
- [ ] 真实质量：Memory Provider 对照、天气/路由有效样本、完整版本化路由负例及业务 P95/成本阈值。
- [ ] 生产运行：正式 Trace、TLS/Auth/备份与真实查询、生产多实例、跨实例取消。
- [ ] 安全与副作用：内容审核、正式资产治理、Sandbox、写操作确认/幂等/回读/补偿。
- [ ] 渠道：真实浏览器可访问性与下载落盘复核。

这些是既有未完成能力或证据的后续门禁；本轮没有把修复治理文档扩展成真实模型调用、部署或新增运行能力。

## 审计项关闭状态

| 项 | 修复结果 |
| --- | --- |
| D1 | 已同步最终稳定契约，保留旧本地回退和受限生产边界 |
| D2 | 已补最新演进关系，修正 Lease、路由引用、视觉 operation 概念和默认模型旧 TODO |
| D3 | 已补模型选择/失败反馈索引，并说明 auto UI 演进范围 |
| D4 | 已增强模板，18 份有效记录均有具体本地验收与未完成门禁；历史结果不改写 |
| D5 | 已补实施路径、维护顺序、兼容说明及 14 个关键入口反向 ADR 引用 |
| D6 | 已建立持久证据登记和可重复验证入口；历史原始外部报告缺失不能凭文档修复，列为补验任务 |
| D7 | 已分开选型接受、本地实现验证、真实质量观察和生产门禁；外部真实/生产验收仍未完成 |
| D8 | 已补废弃状态定义；virtual key 3.4 全量回归/CLI/变更检查完成并追加日期证据 |

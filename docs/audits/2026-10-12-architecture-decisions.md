# 架构与方案决策存量审计（2026-10-12）

后续修复：本报告保留修复前的发现作为历史证据。当前处理结果见 [决策审计修复验证与证据登记](./2026-10-12-decision-repair-evidence.md)；D1-D5/D8 已补齐，D6 的历史外部原始报告缺失和 D7 的真实/生产验收仍为明确门禁。

## 范围与结论

依据 `docs-architecture-decision` Skill、方案选型治理和现有 OpenSpec，对 `docs/decisions/` 中全部 21 份日期前缀记录进行审计：18 份接受、3 份已替代。覆盖记录全文、候选与证据、实施边界、验收、维护与退出、替代关系、索引，以及关键实现和稳定契约的交叉核对。README 和 TEMPLATE 不计为决策。

总体结论：现有成熟方案复用、单一事实源和受限切片的方向有依据；没有发现足以直接支持全面换框架或撤销既有选型的新证据。主要风险是已实现能力没有完整进入稳定契约，以及有效记录未明确承接后续决策，可能让下一位 Agent 按过时约束实现。全部记录都缺少新版 Skill 要求的验收复选框，但不因此否定历史测试证据或把历史接受状态改回提议。

本文件是审计报告，不是新的选型决定；不改写历史理由、接受状态、生产能力等级或稳定契约。前一轮新增 Skill 与路由的未提交变更保留。本轮新增本报告及文档索引入口。

## 优先发现

### D1 / P1：已落地的三组行为没有完整进入稳定 OpenSpec

证据：

- `openspec/specs/ai-platform/spec.md:108` 仍要求 Demo 装配的 Runtime 使用 `LITELLM_MASTER_KEY`；同文件图片请求、GatewayClient 段也保留 master key 要求。
- `src/config/env.mjs:90` 的 `resolveGatewayApiKey` 实际优先选择 `LITELLM_RUNTIME_KEY`。接受记录 `2026-08-02-runtime-virtual-key-mapping.md` 也明确该优先级。
- 稳定 spec 未包含 `AcceptanceResult`、重启恢复完整条件、Operation journal、RunLease/fencing 等完整要求；仅在智能路由部分引用 ExecutionPolicy，并不能替代这些契约。
- 三组 delta 保存在 `integrate-runtime-virtual-key`、`add-durable-run-recovery-and-acceptance`、`add-execution-governance-foundation` 的 `specs/ai-platform/spec.md`。对应代码已装配在 Runtime，接受记录已报告实现。

影响：只阅读稳定 spec 的实现者会恢复管理员凭据路径，或漏掉天气验收、恢复资格和 fencing 不变量。格式严格校验不会检测这种跨文件语义落差。

建议：由 Runtime/Storage/模型网关维护者审阅并合并 delta 的最终有效契约，保留旧本地 master key 回退例外；合并时考虑执行治理已经扩展了恢复切片原先的非目标。验收应确认稳定 spec 包含凭据优先级、验收事务、窄恢复条件、Policy/Hook、Operation 投影和 lease/fencing，并运行相应回归。此审计不直接归档 change 或合并契约。

### D2 / P2：接受记录仍给出已被后续演进覆盖的当前实施指引

- `2026-08-02-c2-multi-turn-image-editing-responses-path.md:83` 将路由边界指向已替代的 `2026-08-02-runtime-smart-operation-routing.md`，没有直接指向 08-15 的活动图片/历史证据决策。历史路由记录虽然有替代提示，多跳仍增加误用风险。
- `2026-07-31-ai-sdk-core-v7-alignment.md:102` 的“后续演进”仍写“当前没有多实例 lease/fencing”，但 08-13 执行治理已落地其基础能力。应区别“有 SQLite 协调基础”和“无生产多实例验收”。
- `2026-08-13-durable-run-recovery-and-acceptance.md:29,65` 排除 Operation journal/lease/fencing，08-13 执行治理记录说明扩展它；前者尚无反向的后续演进提示。
- `2026-07-31-c2-image-understanding-and-generation-boundary.md:73` 选择独立 `image.understand`，08-02 补充却明确理解走 `conversation.chat`；末尾还把受控资产理解/多轮引用列为后续边界，而 08-15 已接受活动图片视觉继承。应说明领域概念与真实 Run operation、受限已实现范围与完整媒体治理的区别。
- `2026-08-01-litellm-governance-poc.md` 的剩余边界仍称默认 `gpt-5.6` 上游变体未决定，模型选择复评、当前 config 已明确 `openai/gpt-5.6-sol`。

建议：在有效记录追加带日期的演进说明和最新有效链接，保留原验收结果。不将每个历史非目标机械改成当前能力，更不把协调基础升级为生产 R4。

### D3 / P2：决策索引漏掉一份有效记录

21 份记录中，仅 `2026-07-30-c1-model-selection-and-failure-feedback.md` 未进入 `docs/decisions/README.md`。该记录包含模型目录授权、operation 能力交集、安全失败反馈及 08-02 复评；UI 前置决策引用它，但索引扫描无法发现。

建议：补索引行并明确“显式 Run 模型选择/能力门禁与安全反馈仍有效，普通 auto 输入的模型控件已由智能路由决策演进”。不要因界面变化将整份安全/能力决策废弃。

### D4 / P2：全部记录的验收计划与历史结果没有统一区分

21/21 份记录没有 Markdown 验收复选框。多数有验证表、脚本路径和历史测试计数，证据并非空白；但是“怎么验收”“曾经通过”“仍未验收”混在正文和完成报告中。现有 TEMPLATE 也没有专门的实施计划和验收复选框，持续使用旧模板会重复该问题。

建议：先增强 TEMPLATE，增加受影响路径/既有模式/配置/迁移和可检查验收清单；现有有效记录在下一次相关修改时追加清单，历史计数注明日期。验收必须覆盖功能和边界，不以补勾选代替真实执行。已替代记录不要求为格式重新验收。

### D5 / P2：ADR 与代码没有反向链接，部分记录不足以直接交接实施

检索 `src/`、`demo/`、`scripts/` 的 `ADR:` 与 `docs/decisions/` 未发现命中。决策侧已有不少代码/测试路径，但关键入口读者无法快速发现治理记录。天气记录以行为为主，缺少集中实施路径和维护责任；恢复记录描述角色和场景较好，但具体 Runtime/Store/Acceptance 装配路径主要需要二次检索。

建议：在 GatewayClient、Runtime、Store、路由器、Responses Adapter 等受决策治理的模块入口增设一条有效决策引用；避免每个函数重复注释。补实施映射时列出新旧数据兼容、配置、验证命令和不实现项，不事后发明历史实施计划。

### D6 / P2：部分关键证据只有本地叙述，无法从仓库独立复核

Phoenix 升级回滚记录使用“本次演练输出”，真实图片/virtual key/spend 验收使用“本地脱敏 PoC”“HTTP/数据库验收记录”，恢复质量观察引用忽略目录 `.data/evaluations/`。版本、摘要、hash 和脚本是有价值的线索，但不是持续可访问的原始证据。静态检索未发现反引号标记的源码/脚本/change 路径缺失；这不代表所有历史报告都能找到或重现。

建议：按风险保留脱敏、版本化报告摘要、可运行步骤、输入 fixture、时间、依赖版本和判定结果；凭据引用只写配置名。正式运行态验收前先核验证据再重跑，不读取真实密钥、不把模型正文或敏感业务数据存入普通审计资产。本轮未重新执行 Docker 后端、真实模型、图片或计费调用。

### D7 / P2：接受方案与能力完成状态需要更明确地分离

- LiteLLM 治理 PoC 明确尚缺版本级许可证证据、Redis 多副本限流与账单对账；不得将 PoC 接受等同于团队共享上线完成。候选缺少轻量可组合路线的缺失解释，需补检索范围。
- 上下文路由记录明确真实样本只有 4 个、完整版本化 fixture 矩阵未齐；本次目录核对也只发现一个续接场景。它可以证明受限开发切片，但不能作为真实识别发布质量基线。
- ChainTrace 延期记录列有触发条件；项目已有工具调用不自动等于触发“明确依赖 Trace 验收”的条件。本轮没有获得正式排障/生产需求新证据，不擅自恢复 TODO。
- 部分重评条件如“P95/成本不可接受”缺少量化阈值，应在正式发布前补业务目标，不能由审计者虚构指标。

建议：分别注明“选型接受、实现验证、真实质量观察、生产门禁”，让上线前仍欠的证据成为可追踪任务；维护者确认触发条件后再恢复对应验证。

### D8 / P3：任务闭环与状态术语仍有小缺口

virtual key change 的 `tasks.md:19` 仍留着未完成项 3.4，并解释当时缺少 OpenSpec CLI。本轮严格校验已成功，相关配置定向回归也通过，但没有执行其所要求的全量回归，不自动勾完该组合任务。Skill 支持废弃，而决策索引状态表尚未定义“废弃”；目前没有废弃记录，不是现有状态错误。

建议：追加本次校验证据，完成未跑的组合检查后更新任务；新增废弃记录前补统一状态语义。保留任务和历史证据日期。

## 逐份审计结果

以下判断不包含“历史真实外部验收重新通过”的承诺。D4/D5 是横向补齐项；表中优先列各记录的独有问题。历史记录保留原状态。

| 决策（相对 docs/decisions/） | 状态 | 评估与下一步 |
| --- | --- | --- |
| `2026-07-29-existing-capability-selection-audit.md` | 接受 | 复用/所有权方向清楚；明确为 07-29 基线，末尾已过时能力盘点需追加演进导航，不作为全部能力已选型凭据；记忆 Provider 真实基准仍待做 |
| `2026-07-29-c1-chaintrace-priority-and-otel-path.md` | 已替代 | 部分替代范围写明且延期记录反向引用；保留历史，不按旧优先级阻断新场景 |
| `2026-07-29-c1-channel-experience-ant-design-x.md` | 接受 | 候选、版本、Adapter 和测试较完整；模型选择、恢复、图片引用后续由其他记录扩展，追加聚合导航 |
| `2026-07-30-c1-chaintrace-backend-comparison.md` | 接受 | 同 Trace 比较、查询/资源/许可差异具体；作为证据记录保留，最终决定读 Phoenix；补持久证据 D6 |
| `2026-07-30-c1-chaintrace-backend-phoenix.md` | 接受 | 固定 digest、Auth、备份回滚及退出清楚；选型不等于真实 Runtime 验收，补演练资产 D6 |
| `2026-07-30-c1-chaintrace-runtime-validation-deferral.md` | 接受 | TODO 触发、默认关闭、风险和恢复顺序完整；未发现本轮必须启动正式实例的证据 |
| `2026-07-30-c1-channel-experience-batches-i1-i4.md` | 接受 | I1-I4、I5/I6 延期和下载人工复核边界明确；补对应执行清单，不把未回传下载事件写成落盘通过 |
| `2026-07-30-c1-model-selection-and-failure-feedback.md` | 接受 | 授权可见不等于能力兼容的复评有价值；索引漏项 D3，补 auto UI 演进说明 |
| `2026-07-30-v1-read-only-tool-loop-and-weather.md` | 接受 | 两组选型和数据/工具边界清楚；补具体实施路径、维护责任、版本化验收，不因短模板重做选型 |
| `2026-07-31-ai-sdk-core-v7-alignment.md` | 接受 | Agent/Core 分流、版本和协议测试明确；当前 lease 说明过时 D2 |
| `2026-07-31-c2-image-editing-ai-sdk-path.md` | 已替代 | 新旧互相引用、失败与单次尝试证据完整；不重新启用旧主路径 |
| `2026-07-31-c2-image-understanding-and-generation-boundary.md` | 接受 | 场景归属、实际尺寸和单样本限制明确；操作名和活动资产理解剩余范围需收敛 D2 |
| `2026-07-31-tool-result-summary-recovery.md` | 接受 | 已追加重启恢复/A3 演进说明，是较好示例；补执行治理后续导航与可执行验收 |
| `2026-08-01-litellm-governance-poc.md` | 接受 | 预算/spend PoC与生产非目标分开；默认模型旧 TODO、许可及候选路线解释待补 D2/D7 |
| `2026-08-02-c2-multi-turn-image-editing-responses-path.md` | 接受 | 强制 edit、零重试、唯一图片结果、兼容字段对照清楚且与 Adapter 相符；更新路由引用 D2，补外部证据 D6 |
| `2026-08-02-runtime-smart-operation-routing.md` | 已替代 | 明确提示历史局限且新旧双向引用；保留为 v1 依据 |
| `2026-08-02-runtime-virtual-key-mapping.md` | 接受 | 配置优先级与同身份链路有实现和定向回归；master 不进入 Runtime 的表述应注明旧本地回退，先修稳定契约 D1 |
| `2026-08-13-durable-run-recovery-and-acceptance.md` | 接受 | 成熟候选、窄恢复点、独立验收和 observation-only 说明充分；补执行治理反向演进 D2，并同步稳定 spec D1 |
| `2026-08-13-execution-governance-foundation.md` | 接受 | Policy/Hook、事实投影、fencing 和生产非目标明确；同步稳定 spec D1，不把基础称生产 R4 |
| `2026-08-13-runtime-event-port-and-delivery.md` | 接受 | Observer/Port、易失事件与事务事实、慢订阅风险边界具体；候选/失败验证较完整，补部署无关实施清单 |
| `2026-08-15-runtime-context-aware-operation-routing.md` | 接受 | 快照、资产派生、证据、并发、重放和双模式评测最具体；完整 fixture/真实基线仍待补 D7，避免小样本发布宣称 |

## 建议执行顺序与验收

- [ ] Runtime/Storage/网关维护者先合并 D1 三组最终稳定契约；再严格校验 stable spec 和相关 change，运行配置、恢复、验收、治理回归。
- [ ] 决策维护者补 D2 有效记录的带日期演进导航和 D3 漏索引，不覆盖历史理由或不相关状态。
- [ ] 文档维护者增强 TEMPLATE，将计划与结果分开；在下一次相关变更补齐有效记录的路径、验收、入口反链（D4/D5）。
- [ ] 治理维护者为 D6 高风险外部验证保留脱敏可复核资产；正式启用前执行许可、真实质量、运维或计费门禁（D7）。
- [ ] 维护者完成 virtual key 组合任务的剩余全量回归，并在需要废弃时先完善状态定义（D8）。

此清单是审计后的修复建议，不表示已授权外部真实调用、正式部署、自动归档 change 或撤销任何已接受选型。

## 本次验证与限制

- stable spec 及 `integrate-runtime-virtual-key`、`add-durable-run-recovery-and-acceptance`、`add-execution-governance-foundation` 的 OpenSpec strict 校验全部通过。语法通过不消除 D1。
- 初次运行发现本地缺少 `ai`、OpenTelemetry 等依赖，使用 `npm ci --ignore-scripts --no-audit --no-fund` 安装锁定依赖后重跑。
- 配置、Runtime 场景、路由场景、Acceptance、执行治理五组定向回归：25/25，通过。未运行全量 npm test，因此不更新历史全量计数。
- 100 轮上下文记忆确定性评测：10/10 checkpoints、5/5 指标、100.0%；仅代表脚本 Runtime/Reducer/Planner 链路，不代表真实模型质量。
- 检索核对 SDK 分流/零重试、Responses edit 请求、Runtime Policy/lease/Acceptance 和 routing-context.v2 等关键实现；未进行逐行代码审查，不把抽样一致性表述为所有实现无缺陷。
- 没有重跑上游模型、真实图片、Phoenix/Langfuse Docker 或 spend 验证，也没有读取历史 SQLite 的敏感业务事实。有关证据按历史记录及可访问资产评估。

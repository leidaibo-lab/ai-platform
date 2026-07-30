# C1 ChainTrace 运行态验收延期

- 状态：接受
- 日期：2026-07-30
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 治理与可观测
- 关联需求：项目当前以功能可用和知识掌握为先，正式 Runtime Trace 在出现真实运维需求后再恢复
- 关联 OpenSpec：不改变 `openspec/specs/ai-platform/spec.md` 已有的默认关闭、旁路导出、安全和失败隔离契约
- 替代记录：仅替代 `2026-07-29-c1-chaintrace-priority-and-otel-path.md` 中“运行态验收完成前不得进入后续建设”的实施优先级；不替代 Phoenix 后端选型

## 问题

项目已经完成 C1 `ChainTracer`、OTLP exporter、脱敏测试、后端对比、Phoenix 选型和部署入口，但尚未在正式 Phoenix 实例上执行真实 Runtime JSON/SSE Run 验收。当前仍处于本地开发和能力学习阶段，暂时没有多人共享、生产 SLO、跨节点排障或持续告警需求；立即补齐正式实例、密钥、备份、监控和运行态基线会引入超过当前阶段收益的知识与运维成本。

本次需要区分“技术能力保留”和“运行态验收完成”：前者已经进入代码与稳定契约，后者作为显式 TODO 延期，不能继续写成当前已完成能力，也不作为当前功能迭代或其他低风险场景调研的硬门禁。

## 约束与非目标

### 必须满足

- `OTEL_ENABLED` 继续默认 `false`，禁用时不得初始化 OTel SDK、Exporter 或 AI SDK Telemetry。
- 保留 `ChainTracer` Port、OTLP/HTTP protobuf exporter、Phoenix Compose、脱敏规则和自动化测试，避免后续重新设计。
- Runtime、SQLite 事实源、JSON/SSE Run、取消、幂等和持久化不得依赖 Phoenix 可用性。
- 文档必须把 PoC/代码接入、后端选型和真实 Runtime 运行态验收分开描述。
- 恢复 TODO 时继续使用已经接受的 Phoenix 方案；若触发既有重评条件，先重新选型。

### 本次不解决

- 不启动正式 Phoenix Compose，不创建管理员或 system API key。
- 不执行真实 Runtime Trace、生产 TLS、高可用、容量、告警或正式备份运维。
- 不删除或回退已经完成的 ChainTrace 代码、契约、测试和部署资产。
- 不因延期自动宣称 C2-C7 已完成；每个场景仍按自身数据、安全和验收边界建设。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 保留接入并延期运行态验收 | 轻量可组合 | 代码、契约和部署资产保留；正式实例与真实 Trace 暂缓 | 当前 Runtime 无额外运维依赖，后续可按既有入口恢复 | 延期期间没有正式 Trace、阶段 P50/P95 和线上查询证据 | 默认关闭契约、`npm run test:telemetry`、现有运维说明 |
| 立即完成正式运行态验收 | 成熟一体化 | Phoenix、PostgreSQL、认证、真实 Run、查询和运维全部启用 | 立即获得完整排障和基线证据 | 当前没有对应运行规模和运维需求，知识与维护成本前置 | `2026-07-30-c1-chaintrace-backend-phoenix.md` |
| 删除 ChainTrace 接入 | 最小回退 | 移除 OTel、Compose、配置和文档 | 表面上减少仓库内容 | 丢失已完成选型和实现，真实需求出现时需要重新建设 | 当前代码、OpenSpec 和后端实测记录 |

三种路线已经覆盖当前可行选择；本次不是新增后端或自研通用机制，因此不再扩展新的观测候选。

## 淘汰条件

- 方案会改变当前 Runtime 的业务成功、失败、取消、幂等或持久化语义。
- 方案要求当前阶段持续运行 Phoenix、管理正式凭据或承担生产运维。
- 方案删除已有标准 OTLP 和后端中立边界，导致后续重新建设或供应商锁定。
- 方案继续把未执行的真实 Runtime Trace 写成已完成能力。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 禁用 Trace 不影响 Runtime | 使用默认 `OTEL_ENABLED=false` 执行现有回归 | 当前 V0.6 Runtime | 已由 Null Object 和自动化测试覆盖 | `scripts/test-chain-trace.mjs`、stable OpenSpec |
| 后续恢复不需要重新选型 | 核对 exporter、固定后端和运维入口 | OTLP/HTTP protobuf、Phoenix 19.10.0 + PostgreSQL 17 | 已具备代码、配置、Compose 和运维步骤 | `src/observability/otel-runtime.mjs`、`docker-compose.chaintrace.yml`、`docs/c1-chaintrace-operations.md` |
| 当前不能宣称运行态闭环 | 核对正式实例真实 JSON/SSE Run 验收证据 | `requestId + conversationId + runId` | 待执行，明确列为 TODO | 本记录和 `docs/scenario-interaction-chains.md` |

## 决策

- 结论：采用
- 选择方案：保留 ChainTrace 技术接入并延期正式运行态验收
- 决策依据：当前功能链路不依赖 Trace，项目尚未产生需要正式观测后端解决的运行规模和排障问题；保留默认关闭的标准化接入，可以避免当前过度建设，同时保留低成本恢复路径
- 平台拥有：`ChainTracer` Port、`ai.platform.*` 属性、采样、脱敏、失败隔离、自动化测试和 TODO 触发门禁
- 外部方案负责：TODO 恢复后由 Phoenix 和 PostgreSQL 承担 Trace 摄取、存储、查询、权限与保留
- 明确不实现：当前阶段不启动正式实例、不发放正式凭据、不建设监控告警和运行态基线

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| 立即完成正式运行态验收 | 当前收益不足以覆盖部署、凭据和运维学习成本 | 出现真实排障、指标、多人共享或准生产需求 |
| 删除 ChainTrace 接入 | 已有实现默认关闭且不影响主链，删除会浪费已完成证据并提高恢复成本 | stable OpenSpec 和项目方向明确永久取消 ChainTrace |

## 实施边界

当前阶段保持 `OTEL_ENABLED=false`，日常启动不要求运行 `docker-compose.chaintrace.yml`。允许继续维护与现有 Runtime 变更直接相关的埋点契约和回归测试，但不主动扩建 Trace 页面、告警、统计平台或供应商私有集成。其他场景可以依据真实业务价值进入调研或最小实现，不能因为 ChainTrace 资产存在就跳过该场景自身的权限、数据所有权、错误语义和测试门禁。

TODO 在满足任一条件时恢复：

- 出现仅靠 Run 状态和日志无法定位的真实链路问题。
- 需要阶段耗时、端到端 P50/P95、重试、Token 或成本基线。
- 进入多人共享、准生产或生产部署。
- Runtime、模型网关或模型路由扩展为多个运行节点或候选。
- 某个后续场景具有工具调用、外部副作用或跨服务恢复，明确依赖端到端 Trace 验收。
- 维护者已具备对应 OTel、Phoenix 和 PostgreSQL 运维知识，并决定完成 C1 运行态验收。

恢复后的最小完成顺序是：启动正式 Compose 和认证、执行真实 JSON/SSE Run、按三个业务 ID 查询完整 Trace、检查 Span 与敏感数据、验证 exporter 故障隔离，再建立四维基线和告警阈值。

## 风险与退出路径

- 已知风险：延期期间发生复杂故障时，缺少正式阶段 Trace 和历史基线；通过保留 Run 状态、现有日志和可随时启用的接入降低恢复成本
- 锁定点：stable OpenSpec 已接受 Phoenix 部署约束，但 Runtime 仍只依赖标准 OTLP 和 `ChainTracer`
- 退出路径：触发条件出现时按运维说明恢复；若长期不触发，继续默认关闭；若项目永久取消该能力，再单独更新 OpenSpec 并移除实现
- 维护责任：平台维护者负责保持默认关闭、测试和文档一致；TODO 恢复后再明确 Phoenix/PostgreSQL 的实际运维责任人

## 验收与完成报告

- 验证证据：本次只调整阶段优先级和能力声明，不把现有 PoC 或后端演练冒充真实 Runtime 验收
- 剩余边界：正式实例、真实 JSON/SSE Trace、三业务 ID 运行态查询、隐私复核、故障隔离和四维基线均为 TODO
- 文档与契约：同步 README、架构说明、场景路线、运维说明和决策索引；代码、配置默认值与 stable OpenSpec 行为不变
- 重评条件：上述任一 TODO 触发条件成立，或项目阶段和维护能力发生变化

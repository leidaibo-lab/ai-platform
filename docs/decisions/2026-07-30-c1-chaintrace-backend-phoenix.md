# C1 ChainTrace 最终后端采用 Phoenix

- 状态：接受
- 日期：2026-07-30
- 负责人：AI 应用基础平台维护者
- 所属区域：治理与可观测
- 关联需求：承接当时“先完成 C1 ChainTrace 再扩其他场景”的选型阶段；后续运行态验收时机已调整为触发式 TODO
- 关联 OpenSpec：后端选择接受后，已同步 `openspec/specs/ai-platform/spec.md` 的 C1 ChainTrace 稳定契约
- 替代记录：无；承接 `2026-07-30-c1-chaintrace-backend-comparison.md` 的实测结论

后续阶段安排：Phoenix 选型、固定版本和部署边界继续有效；正式实例与真实 Runtime Trace 验收已由 `2026-07-30-c1-chaintrace-runtime-validation-deferral.md` 调整为触发式 TODO。

## 问题

C1 已有后端中立的 `ChainTracer`、AI SDK Telemetry 和 OpenTelemetry PoC，但还没有接受正式 Trace 后端。最终后端必须在不成为业务事实源、不记录业务正文的前提下，提供私有部署、业务属性精确检索、认证、当前团队所需 RBAC、保留和可恢复升级能力，并保持通过 OTLP 替换后端的退出路径。

成功证据是：同一批脱敏 C1 Trace 在候选间完成真实对比；最终候选使用 PostgreSQL 和认证完成旧版本写入、当前版本升级、新写入、备份恢复和旧版本回滚；全过程可按 `requestId + conversationId + runId` 定位 Trace，且不出现 Prompt、回答、图片或文档 URL。

## 约束与非目标

### 必须满足

- Conversation、Run、Message 和 Memory 继续由 Runtime SQLite Store 持有，Trace 后端只作为旁路证据系统。
- 正式初始版本固定为 Phoenix 19.10.0 的不可变镜像 digest，并使用 PostgreSQL 17 持久化。
- 生产启用认证、30 天默认保留和关闭匿名 telemetry；凭据只由服务端配置持有。
- 平台继续拥有 `ChainTracer` Port、`ai.platform.*` 属性、采样、脱敏和导出失败隔离。
- 使用后端中立 OTLP/HTTP protobuf，不把 Phoenix 私有 SDK 引入 Runtime 主链。
- 当前单团队 C1 接受实例级 `admin/member/viewer` 三角色边界；出现多组织空间、SAML/JIT 或项目级隔离需求时重新选型。
- 每次升级先备份并校验，升级后验证旧 Trace 和新写入；回滚必须恢复升级前数据库，不能只回退应用镜像。

### 本次不解决

- 本记录不完成生产部署、TLS、监控告警、高可用、容量规划或正式密钥发放。
- 不把 Trace 作为用户可见回答、会话恢复、计费或审计事实的唯一来源。
- 不启用 Phoenix Agent Assistant、MCP code mode、代码沙箱或模型供应商配置。
- 不进入 C2-C7、RAG、工具循环或工作流观测。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| Phoenix 19.10.0 + PostgreSQL 17 | 成熟一体化 | OTLP 摄取、存储、查询、UI、RBAC、保留 | 单容器应用、业务属性精确查询、当前所需 RBAC 和保留不依赖额外商业能力 | 只有实例级三角色；生产仍需外部 PostgreSQL、入口 TLS 和运维治理 | 双后端 PoC 与本记录升级回滚演练 |
| Langfuse 官方 Compose | 成熟一体化 | AI 观测、组织/项目、Trace、评测和运营工作流 | 组织与项目模型更完整 | 六服务资源明显更高；OTLP 属性只能对嵌套对象做包含过滤；项目级 RBAC 和自动保留存在许可边界；Compose 运行版本不可直接由 release 标签确定 | `2026-07-30-c1-chaintrace-backend-comparison.md` |
| SQLite Trace + 自研查询 | 最小自研 | 采集、存储、查询、权限和页面均由平台实现 | 表面上依赖少 | 重复建设通用基础设施，维护与安全成本不可接受 | `2026-07-29-existing-capability-selection-audit.md` |

轻量可组合路线由“项目自有 `ChainTracer` Port + 标准 OTLP + 成熟后端”承担，不再引入第四个 Trace 后端候选。

## 淘汰条件

- 不能私有部署或不能关闭匿名 telemetry。
- 不能按三个稳定业务 ID 精确定位 C1 Run。
- 必须记录 Prompt、回答、图片、文档 URL 或原始错误正文才能工作。
- 必须成为 Runtime 事实源，或必须把供应商私有 SDK 放入业务主链。
- 当前所需认证、三角色 RBAC、保留或备份恢复被付费门禁阻断。
- 升级后旧 Trace 丢失，或不能从升级前备份恢复到可查询状态。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| Phoenix 与 Langfuse 能接收同一批 Span | Composite exporter 同时导出 | 同一 9 Span、`trace_id=ac7cef84b2c06a295ab4e488fdbbda2b` | 两端接收成功 | `2026-07-30-c1-chaintrace-backend-comparison.md` |
| Phoenix 支持业务属性精确检索 | REST API 组合三个 `attribute` 条件 | Phoenix 19.10.0 | 返回唯一 Trace 的 9 个 Span | 对比记录“查询差异” |
| 认证保护查询与写入 | 开启 Auth，分别匿名和 Bearer 查询 | Phoenix 19.9.0 + PostgreSQL 17 | 匿名 `401`；管理员 token 返回 9 个 Span | 本次演练输出 |
| 旧版数据可升级到当前版 | 19.9.0 写入后，以 19.10.0 不可变 digest 连接同一 PostgreSQL | 旧 Trace `65085452a6cb9e9bba8676f208a47e29` | 旧 9 Span 保留；升级后新写入 9 Span 成功；总数 18 | 本次演练输出 |
| 数据库可恢复并回滚应用 | `pg_dump --format=custom`，重建数据库并 `pg_restore`，再启动 19.9.0 digest | 备份 240,706 bytes，SHA-256 `1a09db4575352982ef136d2b0461c2b7e13b6bd9f7467a647750c90ea238df74` | 旧 Trace 恢复为 9 Span；升级阶段新增 Trace 为 0；匿名仍 `401` | 本次演练输出 |
| 敏感正文不进入后端 | 扫描 runner 内存与各阶段 API 响应 | 固定四类敏感 fixture | 全部无命中 | runner 与临时 API 响应扫描 |

演练固定镜像：

- Phoenix 19.9.0：`arizephoenix/phoenix@sha256:05de826a12c1e56f1c8938b1fabc6bb21d9b492a1acbd7dc4116a7c5137c4169`
- Phoenix 19.10.0：`arizephoenix/phoenix@sha256:3092f5543a3ddd35db7390cf971027c33be6be1f171274d57f3c8658c2193d67`
- 两个版本的 Alembic 基线均为 `c9d0e1f2a3b4`，本次升级没有数据库结构变化；恢复流程仍按可能存在不可逆迁移设计。

## 决策

- 结论：采用
- 选择方案：Phoenix 19.10.0 + PostgreSQL 17；正式初始部署固定上述 19.10.0 digest
- 决策依据：Phoenix 满足当前 C1 的私有部署、精确检索、认证、实例级 RBAC、保留、资源和可恢复升级要求；运行单元与资源显著少于 Langfuse，且不需要自研 Trace 后端
- 平台拥有：`ChainTracer` Port、业务属性、采样、脱敏、OTLP exporter 配置、导出失败隔离、回归 fixture 和 C1 验收规则
- 外部方案负责：OTLP 摄取、Trace/Span 存储和索引、查询 API、可视化、实例级 RBAC、保留清理
- 明确不实现：Trace 数据库、检索 API、观测 UI、供应商私有追踪协议、MCP code mode 和代码沙箱

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| Langfuse | 当前查询语义、六服务资源和许可边界不如 Phoenix 适配；官方 Compose 的 release 与实际应用版本也不够明确 | 组织/项目级权限、AI 评测运营工作流成为硬需求，且许可、资源和固定版本问题解决 |
| SQLite Trace + 自研查询 | 重复实现采集、索引、权限、保留和页面，违反成熟方案优先 | 成熟方案都无法满足数据或安全硬边界，且有明确长期维护团队 |
| Phoenix 内置 SQLite 作为正式部署 | 只适合本地和低规模，不承担团队共享、备份恢复和独立数据库运维边界 | 仅限单机开发或临时诊断环境 |

## 实施边界

- Runtime 只依赖 `ChainTracer`，默认关闭时继续使用 Null Object；开启后通过 OTLP exporter 连接 Phoenix。
- 正式配置只暴露后端中立的 OTel 开关、endpoint、认证 header、service name 和采样率；Phoenix 部署参数归治理与可观测区域所有。
- exporter 超时、拒绝或后端不可用不得改变 Run 成功、失败、取消、幂等或持久化语义。
- `recordInputs` 和 `recordOutputs` 继续关闭；错误只记录脱敏类别和安全状态，不记录原始异常正文或 stack。
- 生产 PostgreSQL 不与 Runtime SQLite、LiteLLM 或业务数据库共享数据所有权。
- 正式接入先修改 OpenSpec，再增加部署入口、配置说明、健康检查和回归测试；不得直接把本轮临时 Docker 命令复制为生产定义。

## 风险与退出路径

- 已知风险：Phoenix 目前只有实例级三角色；镜像内 Monty binary 缺失会告警。正式部署关闭未使用的 MCP code mode，并在入口层提供 TLS、网络隔离和密钥轮换。
- 锁定点：Phoenix PostgreSQL schema、查询 UI 和运维流程；Runtime 侧不使用 Phoenix 私有 SDK，锁定不进入业务主链。
- 退出路径：保留标准 OTLP 和 `ai.platform.*` 属性；迁移时双写受控脱敏 Trace、验证新后端后停旧 exporter，历史 Trace 按后端导出和保留策略处理。
- 维护责任：平台维护者负责 Span 契约、脱敏、采样和回归；治理与可观测维护者负责 Phoenix、PostgreSQL、备份、升级、RBAC、容量和告警。

## 验收与完成报告

- 验证证据：双后端同 Trace、业务属性精确查询、隐私扫描、PostgreSQL + Auth、19.9.0 到 19.10.0 升级、新写入、备份恢复和回滚全部通过
- 剩余边界：本记录只完成后端决策；生产 TLS、部署、监控、容量和正式密钥仍属于正式接入阶段
- 文档与契约：本记录、决策索引、stable OpenSpec、README、部署说明和自动化回归均已同步；真实 Runtime Trace 与固定模型四维运行态基线按延期记录的触发条件恢复
- 重评条件：出现多组织/项目空间、SAML/JIT、跨团队隔离、保留合规变化、容量超出单应用 + PostgreSQL、Phoenix 改变 OTLP 属性语义，或 Langfuse 解决当前查询/许可/固定版本缺口

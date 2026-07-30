# C1 ChainTrace 后端对比

- 状态：接受
- 日期：2026-07-30
- 负责人：AI 应用基础平台维护者
- 所属区域：治理与可观测
- 关联需求：使用同一组脱敏 C1 OTLP Trace 对比 Langfuse 与 Phoenix，再接受最终后端决策
- 关联 OpenSpec：双后端 PoC 阶段不修改稳定契约；最终后端接受后已同步 `openspec/specs/ai-platform/spec.md`
- 替代记录：无；承接 `2026-07-29-c1-chaintrace-priority-and-otel-path.md` 的双后端门禁

## 问题

当前 C1 已通过 AI SDK Telemetry + OpenTelemetry PoC，但“可以导出 Span”还不能证明观测后端满足私有部署、业务标识检索、脱敏、权限、保留、升级和成本要求。本记录使用同一批 `ReadableSpan` 和同一 `trace_id` 对比两个候选，在证据完整且负责人接受最终决定前，不宣布生产后端或正式接入完成。

## 约束与非目标

### 必须满足

- 同一批 Trace 同时发往两个候选，避免先后运行产生不同 Span 树或标识。
- 能按 `requestId + conversationId + runId` 定位 C1 Run，并保留业务 Chain ID 和 OTel `trace_id`。
- Span 树包含 C1 接入、排队、规划、模型、持久化和交付阶段，模型重试仍归属同一 Trace。
- Prompt、回答、图片、文档 URL、原始错误正文和 stack 不进入候选后端。
- 后端保持旁路，不得成为 Conversation、Run、Message 或 Memory 事实源。
- 对私有部署、数据驻留、鉴权、RBAC、保留、升级、资源和许可成本给出官方或实测证据。

### 本次不解决

- 不在本记录中接受最终生产后端。
- 不默认启用 OTel，不修改 Session/Run API，不接入生产凭据。
- 不自研 Trace 存储、查询 API、管理页面或通用扇出组件。
- 不进入 ToolLoopAgent、MCP、RAG 或 C2-C7。

## 候选与版本

| 候选 | 本次核对版本 | OTLP 接入 | 私有部署与数据边界 | 当前主要风险 |
| --- | --- | --- | --- | --- |
| Langfuse | GitHub `v4.0.0`；该标签的官方 Compose 使用 `langfuse:3`，健康端点实测应用版本为 `3.224.3` | OTLP HTTP `/api/public/otel/v1/traces`；Basic Auth；v4 实时摄取需 `x-langfuse-ingestion-version: 4` | 可在 Docker、Kubernetes 或本地云环境部署；生产栈包含 Web、Worker、Postgres、ClickHouse、Redis/Valkey 和对象存储 | 项目级 RBAC 与自托管数据保留属于 Enterprise Edition；GitHub release、Compose 镜像通道和运行版本不一致，升级门禁仍需验证 |
| Phoenix | GitHub `arize-phoenix-v19.10.0` | OTLP HTTP `:6006/v1/traces`，另支持 OTLP gRPC `:4317` | 官方声明自托管免费、无功能门禁，数据可完全留在基础设施内并支持隔离网络 | 只有实例级 `admin/member/viewer` 三类角色；多级组织空间、SAML/JIT 等需要 Arize AX |
| SQLite Trace + 自研查询 | 不进入 PoC | 私有格式 | 数据可留在当前 Runtime | 重复建设采集、索引、查询、权限、保留和可视化，继续淘汰 |

版本和能力依据：

- [Langfuse OpenTelemetry](https://langfuse.com/integrations/native/opentelemetry)
- [Langfuse Self Hosting](https://langfuse.com/self-hosting)
- [Langfuse RBAC](https://langfuse.com/docs/administration/rbac)
- [Langfuse Data Retention](https://langfuse.com/docs/administration/data-retention)
- [Langfuse v4.0.0](https://github.com/langfuse/langfuse/releases/tag/v4.0.0)
- [Phoenix Tracing Quick Start](https://arize.com/docs/phoenix/get-started/get-started-tracing)
- [Phoenix Self Hosting](https://arize.com/docs/phoenix/self-hosting)
- [Phoenix RBAC](https://arize.com/docs/phoenix/settings/access-control-rbac)
- [Phoenix Data Retention](https://arize.com/docs/phoenix/settings/data-retention)
- [Phoenix 19.10.0](https://github.com/Arize-ai/phoenix/releases/tag/arize-phoenix-v19.10.0)

## 官方能力证据

| 维度 | Langfuse | Phoenix |
| --- | --- | --- |
| OTLP | HTTP/JSON 与 HTTP/protobuf；当前不支持 OTLP gRPC | HTTP 与 gRPC |
| 本地低规模 | Docker Compose；官方明确不含高可用、扩缩容和备份 | 单容器、Docker Compose、Kubernetes、Helm 和多云模板 |
| 生产依赖 | Web + Worker + Postgres + ClickHouse + Redis/Valkey + S3/Blob | 单实例可用 SQLite；团队共享和生产建议 PostgreSQL，规模化再按官方架构拆分 |
| 基础角色 | Owner、Admin、Member、Viewer、None；组织级角色可用 | Admin、Member、Viewer，UI 与 API 同时受控 |
| 细粒度权限 | 项目级角色在自托管为 Enterprise Edition | OSS 提供实例级三角色；多层账户/组织/空间不在 Phoenix OSS |
| 保留期 | 自托管默认永久；项目级自动保留在自托管为 Enterprise Edition，最短 3 天 | 默认永久；9.0+ 支持按时间或 Trace 数自动清理，可用环境变量设置默认天数 |
| 数据驻留 | 可 VPC / on-prem，互联网可选 | 官方声明数据不离开基础设施，可完全隔离网络 |

## PoC 方法

`scripts/run-chain-trace-backend-poc.mjs` 只用于候选对比：

1. 通过真实 `ChainTracer`、AI SDK telemetry 和 fake LiteLLM 生成 C1 根 Span、阶段 Span 与 GenAI Span。
2. 在内存中创建一次 `ReadableSpan[]`，由 PoC Composite 同时交给 Langfuse、Phoenix 和 `InMemorySpanExporter`。
3. 使用 OTLP/HTTP protobuf 导出；OpenTelemetry JS 的 OTLP/HTTP JSON exporter 实测被 Phoenix 19.10.0 以 `415` 拒绝，不能作为双后端共同编码。
4. 两个候选获得相同的 `trace_id`、Span 树、业务查询字段和 Token 分段。
5. 内存副本扫描固定 Prompt、回答、图片 data URL 和文档 URL，任一值出现即失败。
6. fake LiteLLM 不读取或转发请求正文，不调用真实模型，不使用项目 `.env` 中的上游 key。

运行双后端验证：

```bash
source .env
npm run poc:chain-trace-backends
```

只验证单个候选时显式设置 `CHAIN_TRACE_POC_TARGETS=langfuse` 或 `CHAIN_TRACE_POC_TARGETS=phoenix`；单候选结果只能作为局部证据，不能替代双后端门禁。

## 关键验证

| 假设 | 输入与版本 | 当前结果 | 证据 |
| --- | --- | --- | --- |
| 两个候选都能接收同一批脱敏 C1 OTLP Span | 相同 runner、相同 `trace_id`；Langfuse Compose 实际应用 3.224.3 / Phoenix 19.10.0 | 通过；两端均接收 9 个 Span | runner 返回 `trace_id=ac7cef84b2c06a295ab4e488fdbbda2b`、`backends=[langfuse, phoenix]` 和 `privacyScan=passed`；两端 API 均返回同一 9 节点树 |
| Phoenix 可按三个业务 ID 定位 Trace | Phoenix 19.10.0 | 通过；三个 `attribute` 精确条件组合返回 9 个 Span 和唯一 `trace_id` | `/v1/projects/default/spans` 使用 `ai.platform.request_id`、`conversation_id`、`run_id` 过滤 |
| Langfuse 可按三个业务 ID 定位 Trace | Langfuse Compose 实际应用 3.224.3 | 有条件通过；三个 ID 对 `metadata.attributes` 做 `contains` 组合过滤返回唯一 Trace；按独立 `ai.platform.*` 元数据键精确过滤返回 0 条 | `/api/public/traces` 的 JSON `filter` 实测；OTLP 属性在 Trace API 中位于嵌套 `metadata.attributes`，查询语义弱于 Phoenix 的属性精确匹配 |
| 两端都不包含四类敏感 fixture | 固定 Prompt、回答、图片和文档 URL | 通过 | runner 内存扫描通过；两端 API 原始响应再次扫描均无命中，Langfuse Trace/Observation 的 `input`、`output` 均为 `null` |
| 权限和保留满足当前团队边界 | 官方当前版本 | 已确认能力差异，尚未获得组织许可与成本边界 | 本记录“官方能力证据” |

## 双后端实测摘要

本次双后端门禁使用以下安全标识，方便复核但不代表生产数据：

| 标识 | 值 |
| --- | --- |
| OTel `trace_id` | `ac7cef84b2c06a295ab4e488fdbbda2b` |
| `requestId` | `poc-request-599501ac-7af5-42a3-9385-a666cd599df3` |
| `conversationId` | `poc-conversation-599501ac-7af5-42a3-9385-a666cd599df3` |
| `runId` | `poc-run-599501ac-7af5-42a3-9385-a666cd599df3` |
| business Chain ID | `poc-chain-599501ac-7af5-42a3-9385-a666cd599df3` |

两端均保留 `c1.conversation.run` 根节点、排队、Run 落库、Context Planner、AI SDK Agent/Step/Generation、完成落库和 JSON 交付共 9 个 Span。Context Planner 分段为 system 12、current input 18、memory 6、episodes 0、history 24、total input 60；模型 Generation 为 input 60、output 8、total 68。

### 查询差异

| 候选 | `trace_id` 直查 | 三业务 ID 组合查询 | 实测边界 |
| --- | --- | --- | --- |
| Phoenix | 支持 | 三个 `attribute=key:value` 条件精确匹配，返回同一 Trace 的 9 个 Span | API 原生保留 `ai.platform.*` 属性键和值，适合当前稳定查询标识 |
| Langfuse | 支持 | 三个值对 `metadata.attributes` 做 `contains` 可唯一命中 | 按独立 `ai.platform.*` 元数据键精确过滤未命中；当前只能对嵌套属性对象做字符串包含查询，存在误匹配和索引语义不明确风险 |

### 本地资源快照

以下数据只用于同机、空闲低负载 PoC 的相对比较，不是容量规划或性能基准：

| 候选 | 运行单元 | 单次内存快照 | 本地镜像逻辑尺寸 | 其他实测 |
| --- | --- | --- | --- | --- |
| Phoenix 19.10.0 | 1 个容器，内置 SQLite | 约 409 MiB | 约 1.08 GB | 显式关闭匿名 telemetry；默认保留设置为 30 天；Monty binary 缺失只影响代码沙箱，不影响 Web/REST/OTLP |
| Langfuse 官方 Compose | 6 个容器 | 合计约 2.45 GiB；其中 Web 917 MiB、ClickHouse 1.07 GiB | 六个镜像逻辑尺寸合计约 3.95 GB，未扣除共享层 | 六个服务均健康，显式关闭 telemetry；健康端点报告应用版本 3.224.3 |

Phoenix 已完成固定镜像、PostgreSQL 数据、认证、备份恢复和 19.9.0 -> 19.10.0 -> 19.9.0 升级回滚演练，旧 Trace、新写入和恢复边界均已验证，详见 `2026-07-30-c1-chaintrace-backend-phoenix.md`。Langfuse v4.0.0 仓库标签的官方 Compose 仍使用 `:3` 通道，无法仅凭 Compose 文件确认可复现的应用版本升级；该缺口已作为未采用原因保留，不再阻塞 Phoenix 最终决策。

## 当前判断

- 双后端对比证据已经接受；最终后端由 `2026-07-30-c1-chaintrace-backend-phoenix.md` 选择 Phoenix。
- Phoenix 在轻量私有部署、业务属性精确查询、开源 RBAC 和开源保留策略上具有明显成本优势。
- Langfuse 在组织 / 项目模型和 AI 观测工作流上更完整，但当前所需项目级 RBAC、自动保留会引入 Enterprise Edition 许可边界，且本次 OTLP 属性只能通过嵌套对象包含过滤定位。
- 最终选择必须同时参考真实查询体验、团队权限需求、保留期要求、生产资源和升级演练，不能只按功能数量决定。

## 风险与退出路径

- 已知风险：Langfuse v4.0.0 仓库标签与官方 Compose 的实际应用版本 3.224.3 不一致；两端对 OTel GenAI 属性的索引和展示也不同。
- 锁定点：OTLP 协议和项目自有 `ai.platform.*` 属性，不使用候选私有追踪 SDK 作为 Runtime 必选依赖。
- 退出路径：保留 `ChainTracer` Port 和后端中立属性，更换候选只替换导出配置；业务事实仍由 SQLite Runtime Store 持有。
- 维护责任：平台维护者负责业务 Span、采样、脱敏和回归；最终后端的部署、备份、升级和权限已由 Phoenix 最终接受记录明确所有者。

## 下一门禁

双后端查询、隐私、本地资源、PostgreSQL + Auth、固定版本升级、备份恢复和回滚证据已经补齐，最终后端决策见 `2026-07-30-c1-chaintrace-backend-phoenix.md`。stable OpenSpec、正式 OTLP exporter、部署入口、配置说明和回归测试均已接入；真实 Runtime Trace 和四维运行态基线的执行时机后续由 `2026-07-30-c1-chaintrace-runtime-validation-deferral.md` 调整为触发式 TODO。

# LiteLLM 网关治理专项 PoC

- 状态：接受
- 日期：2026-08-01
- 负责人：AI 应用基础平台维护者
- 所属区域：模型网关
- 关联需求：公司内部共享模型服务的成本、预算和限流治理
- 关联 OpenSpec：不涉及稳定契约；PoC 不改变现有 Runtime API
- 替代记录：无

## 问题

当前 LiteLLM 仅使用单一 master key 和本地配置，无法按团队或应用限制模型访问、预算和速率，也没有可供平台关联的网关 spend 事实。目标是在不改变 Runtime 主链且不重建网关计费系统的前提下，验证固定 LiteLLM `1.89.1` 是否能以 PostgreSQL 为事实源完成 virtual key、预算硬拒绝和基础限流。

## 约束与非目标

### 必须满足

- 保持 `渠道 -> Runtime -> GatewayClient -> LiteLLM` 作为唯一业务主链。
- LiteLLM 使用现有固定 digest，PoC 数据库与现有 Runtime SQLite、Phoenix PostgreSQL 分离。
- 默认不调用真实上游模型，不产生外部模型费用。
- PoC 不读取、打印或提交主工作区 `.env` 的真实密钥。

### 本次不解决

- 正式多租户控制面、SSO、RBAC、账单对账、生产备份和多实例高可用。
- 由 Runtime 重复实现 virtual key、网关预算、TPM/RPM 或 provider 路由。
- 在没有真实业务身份映射前对外开放 virtual key。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| LiteLLM Proxy + PostgreSQL | 成熟一体化 | virtual key、模型访问、预算、限流、spend | 已在主链使用，固定 `1.89.1` 包含 `/team/new` 与 `/key/generate` 管理端点 | 精确许可证、spend 对账与多实例 Redis 仍需验证 | LiteLLM 容器 `litellm --version`；官方 Virtual Keys / Team Budgets 文档 |
| Runtime 自研网关账本与限流 | 最小自研 | 按业务字段计费和限制 | 贴近业务 Run | 重复实现预算、并发、模型访问与网关治理，维护成本高 | `docs/solution-selection-governance.md` |
| 托管 AI Gateway | 成熟一体化 | 路由、预算、观测 | 运维负担更低 | 改变自托管、现有 LiteLLM 和 provider-neutral 边界 | `docs/decisions/2026-07-29-existing-capability-selection-audit.md` |

## 淘汰条件

- 不能使用 PostgreSQL 持久化 team、key 与 spend，或零预算请求不能在上游调用前被拒绝。
- 需要 Runtime 直接管理 provider key 或绕过 LiteLLM 才能实现预算闸门。
- PoC 改变现有 Runtime 业务 API 或污染其 SQLite 事实源。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 固定镜像支持数据库治理 | 运行 `litellm --version` 并读取容器管理路由 | digest `89cc...`, LiteLLM `1.89.1` | 通过 | Docker PoC 终端记录 |
| team、virtual key 与预算可持久化 | 启动独立 PostgreSQL 后调用 `/team/new`、`/key/generate` | `docker-compose.gateway-governance.yml`，LiteLLM `1.89.1` | 通过：分别创建 1 个 team 与 1 个 key | `scripts/test-gateway-governance.mjs` |
| 零预算可硬拒绝 | 用零预算 key 调用 `/v1/chat/completions` | 不依赖真实上游 key | 通过：返回客户端错误且包含 budget/spend/exceed 语义 | `scripts/test-gateway-governance.mjs` |
| LiteLLM 持久化 spend 事实 | 查询独立 PostgreSQL 的迁移结果 | LiteLLM `1.89.1` | 通过表结构：存在 `LiteLLM_SpendLogs` 及 Daily Team/User/Organization spend 表；尚未产生真实上游账单 | Docker PoC 终端记录 |
| 真实模型 spend 可归集 | 用受限 virtual key 发起一次最多 8 输出 token 的文本调用，并轮询 team 累计费用 | 首次使用不存在的裸 `gpt-5.6` 失败；随后根据上游模型目录改用 PoC 专属别名 `governance-smoke -> openai/gpt-5.4-mini` | 通过：`4390` 输入 token（缓存 `3840`）、`5` 输出 token，LiteLLM 记录 spend `$0.000723` 并累计到 team 的 `$0.01` 预算 | `scripts/test-gateway-governance.mjs`；Docker PoC 终端记录 |

## 决策

- 结论：采用 LiteLLM 数据库治理能力，平台通过稳定 Adapter 适配。
- 选择方案：固定 LiteLLM `1.89.1` + 独立 PostgreSQL 的最小治理部署。
- 平台拥有：业务身份到 LiteLLM team/key 的映射、Run 关联、聚合展示和账单对账。
- 外部方案负责：模型访问、virtual key、模型白名单、网关预算、限流和 spend 原始事实。
- 明确不实现：Runtime 内的第二套模型网关预算或限流。

## 实施边界

PoC 使用 `4100` 端口、独立 Docker volume 与 `config.gateway-governance.yaml`。文本验证使用独立的 `governance-smoke` 平台别名，映射到已由上游目录确认可用且成本更适合 smoke 的 `gpt-5.4-mini`；不得为修复 PoC 而把项目默认 `gpt-5.6` 偷换成某个具体变体。测试脚本只创建短生命周期 team/key，并以零预算验证拒绝路径；真实 spend smoke 只有在显式注入上游凭据后才执行。Redis 容器已作为未来多实例限流依赖预置，但当前单实例 PoC 不声明 Redis 限流已接入或已验收。

## 风险与退出路径

- 已知风险：LiteLLM 当前版本的许可证、spend 精度和 Redis 多实例限流语义尚未形成版本级证据。
- 锁定点：LiteLLM 管理 API、PostgreSQL schema 和 virtual key 元数据。
- 退出路径：停止 PoC Compose 并删除专用 volume，不影响 Runtime SQLite 或当前 Demo。
- 维护责任：模型网关维护者负责 LiteLLM 配置与数据库；Runtime 维护者负责业务映射与关联。

## 验收与完成报告

- 验证证据：LiteLLM `1.89.1` migration 成功；管理 API 建 team/key；零预算拒绝；PostgreSQL 存在 `LiteLLM_SpendLogs` 与 Daily spend 表；真实 `gpt-5.4-mini` 调用的 usage、正数 spend 和 team 预算累计均通过自动断言。
- 剩余边界：图片计费、许可证、Redis 多副本限流和 provider 账单对账仍待验证。固定本地 Runtime virtual key 接入已由 [`2026-08-02-runtime-virtual-key-mapping.md`](./2026-08-02-runtime-virtual-key-mapping.md) 完成；动态多租户映射仍未实现。项目默认 `gpt-5.6` 仍需单独决定映射到哪个上游变体；本 PoC 不通过偷换默认别名解决该产品决策。
- 文档与契约：PoC 完成后更新本记录与 `docs/decisions/README.md`；只有引入稳定业务身份映射时才更新 OpenSpec。
- 重评条件：PoC 不通过、团队共享上线、进入多实例或出现虚拟 key 与账单归属不一致。

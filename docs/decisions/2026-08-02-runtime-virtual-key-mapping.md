# Runtime 使用 LiteLLM Virtual Key 的模型映射边界

- 状态：接受
- 日期：2026-08-02
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime / 模型网关
- 关联需求：让客户端模型目录、Runtime 生成和 LiteLLM 成本归属使用同一受限身份
- 关联 OpenSpec：`openspec/changes/integrate-runtime-virtual-key/`
- 替代记录：无

## 问题

治理 PoC 已验证 LiteLLM team、virtual key、预算和 spend，但当前 Demo Runtime 仍使用 `LITELLM_MASTER_KEY`，客户端模型目录也因此代表管理员可见范围，而不是业务 Runtime 的授权范围。需要在不建设完整控制面的前提下，让本地 Runtime 使用预先配置的受限 virtual key，并保证模型目录、token counter、模型生成和 spend 归属一致。

## 约束与非目标

### 必须满足

- master key 只用于 provisioning 等模型网关管理操作，不进入普通 Runtime 生成链。
- Runtime、`/api/gateway/status` 和单次 Run 使用同一 virtual key。
- 浏览器只接收模型别名，不接收 virtual key、team ID、上游模型名或 provider key。
- 保留 `LITELLM_MASTER_KEY` 作为现有本地启动的兼容回退，配置了 `LITELLM_RUNTIME_KEY` 时必须优先使用后者。

### 本次不解决

- 动态多租户 key 选择、SSO、RBAC、控制面 UI 和 key 自动轮换。
- 把 LiteLLM 管理 API 暴露为普通 Runtime 或浏览器 API。
- 决定项目默认 `gpt-5.6` 应映射到哪个上游变体。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 运维预配稳定 virtual key，Runtime 只消费 | 轻量可组合 | 本地单应用身份、模型授权、预算与 spend | 复用 LiteLLM；Runtime 无管理权限；改动小且可回退 | 还不是动态多租户控制面 | LiteLLM `1.89.1` `/team/*`、`/key/*` PoC |
| Runtime 按请求调用管理 API 创建或选择 key | 最小自研适配 | 动态租户映射 | 可直接按请求身份选择 | Runtime 获得 master 权限并耦合管理生命周期，违反最小权限 | 当前六区依赖与密钥边界 |
| Runtime 继续使用 master key | 现状 | 所有模型可见、统一调用 | 无新增实现 | 无法表达应用授权、预算和成本归属 | 已验证的治理缺口 |

## 淘汰条件

- Runtime 必须持有 master key 或调用 LiteLLM 管理端点。
- 客户端模型列表与实际生成使用不同 key。
- virtual key 或上游真实模型名进入浏览器响应、Run 请求或普通日志。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 固定 virtual key 可重复配置 | 以固定 team/key 调用 create-or-update 管理端点 | LiteLLM `1.89.1` | 通过：首次 created，第二次 updated，输出无 key | `scripts/provision-gateway-runtime-key.mjs` |
| Runtime key 限制客户端目录 | 用 Runtime key 请求 `/v1/models` 与 `/api/gateway/status` | `governance-smoke` 白名单 | 通过：两处均只返回 `governance-smoke` | `scripts/test-runtime-governance.mjs`；HTTP 验收记录 |
| 同一 key 完成生成和 spend | 从客户端别名创建 Run，再查询 team spend | `governance-smoke -> gpt-5.4-mini` | 通过：Run completed，LiteLLM 记录 `$0.00352725` 并归属 `ai-platform-local` | Runtime/数据库验收记录 |

## 决策

- 结论：适配 LiteLLM virtual key，Runtime 采用最小权限凭据。
- 选择方案：运维预配稳定 virtual key，Runtime 通过 `LITELLM_RUNTIME_KEY` 消费。
- 决策依据：LiteLLM 已拥有 key、模型白名单、预算和 spend；Runtime 只需配置优先级与既有 GatewayClient 复用。
- 平台拥有：业务身份到 virtual key 的发布关系、Runtime 配置契约和 Run 关联。
- 外部方案负责：key 生命周期、模型访问、预算、限流和 spend 原始事实。
- 明确不实现：Runtime 内的 key 管理、预算计算或模型授权数据库。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| Runtime 动态管理 key | 扩大 master key 暴露面并耦合控制面 | 正式控制面发布版本化租户/应用凭据，且通过独立管理服务隔离 |
| 继续使用 master key | 客户端目录和 spend 都无法代表业务身份 | 仅限不启用治理的旧本地环境兼容回退 |

## 实施边界

Provisioning 脚本使用 master key 调用 LiteLLM 管理 API，输出只包含 team ID、key alias、模型白名单和是否创建/更新，不输出 key。Demo Server 加载配置时优先选择 `LITELLM_RUNTIME_KEY`；GatewayClient 继续用同一个 key执行目录、计数和生成。浏览器仍只访问 Demo Server。

## 风险与退出路径

- 已知风险：本地固定 key 不是正式 secret manager；动态多租户仍未实现。
- 锁定点：LiteLLM `/team/info|new|update` 与 `/key/info|generate|update` 管理契约。
- 退出路径：移除 `LITELLM_RUNTIME_KEY` 后回退现有 `LITELLM_MASTER_KEY`；删除 PoC team/key 不影响 Runtime SQLite。
- 维护责任：模型网关维护者负责 provisioning；Runtime 维护者负责配置优先级和客户端目录一致性。

## 验收与完成报告

- 验证证据：配置优先级回归；provisioning 首次创建/二次更新；客户端目录只含授权别名；真实 Run `completed`；team spend 与模型白名单核验通过。
- 剩余边界：动态租户/应用映射、正式密钥存储、轮换、撤销和多实例限流。
- 文档与契约：同步 README、稳定 OpenSpec 与治理 PoC 记录。
- 重评条件：进入多人共享、一个 Runtime 服务多个租户或需要无停机 key 轮换。

## Context

当前 GatewayClient 已经用同一 `apiKey` 访问 `/v1/models`、`/utils/token_counter` 和模型生成，因此无需修改调用协议。缺口在配置：Demo Server 只读取 `LITELLM_MASTER_KEY`，导致 Runtime 拥有管理员权限。LiteLLM `1.89.1` 已验证支持固定 `team_id`、自定义 `key`、`/team/update` 和 `/key/update`。

## Goals / Non-Goals

**Goals:**

- Runtime 使用受限 virtual key，master key 仅用于运维 provisioning。
- 固定本地 team/key 可以重复执行 provisioning，不持续创建重复资源。
- 客户端目录、Run 模型校验和真实生成使用同一 key。

**Non-Goals:**

- 不实现按请求动态选择 key、控制面、SSO 或正式 secret manager。
- 不改变 Run API、模型别名语义或浏览器密钥边界。

## Decisions

### 1. 配置优先级而非新建 GatewayClient

`loadDemoConfig` 使用 `LITELLM_RUNTIME_KEY || LITELLM_MASTER_KEY`。现有 GatewayClient 已满足同一身份调用目录、计数和生成，避免增加第二个客户端或动态分支。

### 2. Provisioning 与 Runtime 分离

独立脚本使用 `LITELLM_GOVERNANCE_MASTER_KEY` 调用管理 API，并用固定 team ID 与预定义 runtime key 执行 create-or-update。脚本不打印 key；Runtime 只读取预配后的 key。

### 3. 保留兼容回退但不视为治理完成

未配置 `LITELLM_RUNTIME_KEY` 时继续使用 `LITELLM_MASTER_KEY`，保证现有本地启动兼容。进入共享环境时，缺少 Runtime key 应由部署门禁阻断，后续再提升为强制配置。

## Risks / Trade-offs

- 固定本地 key 存在于忽略文件，不适合生产 -> 正式环境迁移 secret manager，并保留同名 Runtime 配置契约。
- `/key/update` 语义随 LiteLLM 版本变化 -> 固定 digest，provisioning 回归作为升级门禁。
- master key 回退可能被误用于共享环境 -> 文档标记仅兼容本地，部署阶段增加环境门禁。

## Migration Plan

1. 配置并 provision 本地 team/key。
2. Runtime 指向治理网关并设置 `LITELLM_RUNTIME_KEY` 与 `governance-smoke`。
3. 验证客户端目录、真实 Run 与 spend 归属。
4. 回滚时移除 Runtime key 配置并恢复原网关地址；不迁移 Runtime 业务数据。

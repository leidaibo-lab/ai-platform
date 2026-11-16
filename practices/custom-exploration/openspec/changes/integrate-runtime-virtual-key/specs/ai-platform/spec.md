## MODIFIED Requirements

### Requirement: Server-side secret boundary

系统 SHALL 将模型网关访问凭据和上游真实 key 保持在服务端，并为普通 Runtime 与模型网关管理操作使用不同权限的凭据。

#### Scenario: Runtime uses a restricted LiteLLM virtual key

- **GIVEN** 服务端同时配置 `LITELLM_RUNTIME_KEY` 和 LiteLLM 管理凭据
- **WHEN** Demo Server 装配 GatewayClient
- **THEN** Runtime SHALL 使用 `LITELLM_RUNTIME_KEY` 完成模型目录、token counter 和模型生成
- **AND** Runtime SHALL NOT 使用管理凭据执行普通业务模型调用
- **AND** 浏览器 SHALL NOT 获取 Runtime key、管理凭据、team ID 或上游 provider key

#### Scenario: Legacy local configuration omits the runtime key

- **GIVEN** 本地开发环境未配置 `LITELLM_RUNTIME_KEY`
- **WHEN** Demo Server 加载现有模型网关配置
- **THEN** Runtime MAY 回退 `LITELLM_MASTER_KEY` 保持兼容
- **AND** 该回退 SHALL NOT 被描述为共享或生产环境的治理完成状态

### Requirement: Gateway status endpoint

Demo Server SHALL 提供状态检查接口，并使客户端模型目录与普通 Runtime 调用使用同一 LiteLLM 凭据。

#### Scenario: Browser reads the runtime key model catalog

- **GIVEN** Runtime 使用只授权部分模型别名的 LiteLLM virtual key
- **WHEN** 浏览器请求 `GET /api/gateway/status`
- **THEN** Demo Server SHALL 使用该 Runtime key 请求 LiteLLM `/v1/models`
- **AND** 响应 `models` SHALL 只包含该 key 可见的平台别名
- **AND** 后续 Run SHALL 使用同一 key 校验别名并调用模型
- **AND** 响应 SHALL NOT 包含 virtual key、team ID、上游真实模型或 provider 配置

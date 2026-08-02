## Why

LiteLLM 治理 PoC 已验证 virtual key、预算与 spend，但当前 Runtime 仍使用 master key，客户端模型目录因此不能代表业务身份授权范围。需要让 Runtime 使用预配的受限 virtual key，并保证目录、计数、生成和成本归属来自同一网关身份。

## What Changes

- Runtime 配置新增 `LITELLM_RUNTIME_KEY`，存在时优先于兼容的 `LITELLM_MASTER_KEY`。
- 增加幂等 provisioning 运维入口，为固定本地应用创建或更新 LiteLLM team 与受限 virtual key。
- `/api/gateway/status` 继续只返回同一 Runtime key 可见的模型别名，不暴露 key、team 或上游模型。
- 普通 Run、token counter 和模型生成继续复用同一 GatewayClient，不增加第二套模型访问链。

## Capabilities

### Modified Capabilities

- `ai-platform`：收紧模型网关凭据边界，并明确客户端模型目录与 Runtime virtual key 授权一致。

## Impact

- 配置：增加 `LITELLM_RUNTIME_KEY`，保留旧 master key 回退。
- 模型网关：增加仅供运维使用的 team/key provisioning。
- Runtime：不再要求使用 LiteLLM 管理员凭据。
- 渠道：API 形态不变，模型列表改为受限 key 的真实可见集合。

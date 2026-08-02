## 1. 契约与配置

- [x] 1.1 记录 Runtime virtual key 的方案边界和 OpenSpec delta
- [x] 1.2 增加 `LITELLM_RUNTIME_KEY` 优先级及兼容回退测试

## 2. Provisioning

- [x] 2.1 实现固定 team/key 的幂等 create-or-update 脚本
- [x] 2.2 验证重复执行不新增资源，且输出不包含 key

## 3. 端到端验收

- [x] 3.1 验证 Runtime key 的 `/v1/models` 只包含授权别名
- [x] 3.2 通过 Demo Server `/api/gateway/status` 验证客户端目录
- [x] 3.3 完成一次真实 Runtime Run，并验证 LiteLLM team spend
- [ ] 3.4 运行定向测试、完整回归、OpenSpec strict validation 和 `git diff --check`
  - 2026-08-02 已完成定向测试、86 项完整回归与 `git diff --check`；当前环境没有 OpenSpec CLI，strict validation 保持未完成。

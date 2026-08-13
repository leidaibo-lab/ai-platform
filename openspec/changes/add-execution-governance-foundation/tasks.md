## 1. 契约与选型

- [x] 1.1 记录旧决策重评原因、候选方案、未采用原因和退出路径
- [x] 1.2 定义 Policy/Hook、Operation journal、RunLease/fencing 和明确非目标

## 2. Policy 与 Runtime 接入

- [x] 2.1 实现不可变、版本化 ExecutionPolicy Port 和默认拒绝规则
- [x] 2.2 接入 Run/Tool 前置策略与后置观察 Hook，保持 Hook 失败隔离
- [x] 2.3 让新 Runtime Run acquire/renew/release lease，并在关键写入传递 fencing token

## 3. Operation journal 与存储

- [x] 3.1 增加 operations/run_leases 迁移和结构化映射
- [x] 3.2 实现 Operation 状态迁移、幂等键、unknown/readback 证据 API
- [x] 3.3 在同一事务中桥接 ToolCall 与 Operation
- [x] 3.4 在关键 Run/Tool 写入中拒绝 stale owner

## 4. 回归与边界

- [x] 4.1 增加 Policy 默认拒绝、版本/reason code 和 Hook 隔离测试
- [x] 4.2 增加 Operation 幂等、状态迁移、unknown 不重放测试
- [x] 4.3 增加 lease 竞争、过期接管、renew/release 和旧 fencing token 拒绝测试
- [x] 4.4 验证现有天气只读链路、重启恢复和图片幂等不回归

## 5. 后续能力门禁

- [ ] 5.1 为 Sandbox 建立独立候选方案和安全 PoC
- [ ] 5.2 为首个低风险写操作定义 confirmation、外部幂等、readback、unknown 和 compensation 契约
- [ ] 5.3 在满足长任务/多 Worker/持久 Timer 触发条件时重评 Temporal 等成熟执行引擎

## 6. 文档与验证

- [x] 6.1 同步 README、架构图和 R0-R4/A0-A4 当前状态
- [x] 6.2 运行 `npm run test:governance`、`npm test`、`openspec validate --specs --strict` 和 `git diff --check`

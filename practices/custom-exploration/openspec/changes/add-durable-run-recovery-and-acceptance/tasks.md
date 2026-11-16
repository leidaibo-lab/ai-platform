## 1. 契约与选型

- [x] 1.1 定义首期稳定提交点、恢复资格和明确非目标
- [x] 1.2 比较成熟持久执行方案、轻量适配和最小自研边界
- [x] 1.3 定义 AcceptanceResult 与天气独立验收规则

## 2. 持久化与 Runtime

- [x] 2.1 为 Run 增加绝对截止时间、ChainTrace ID 和 AcceptanceResult 持久化
- [x] 2.2 实现遗留 Run 分类与 completed 只读 ToolResult 总结恢复
- [x] 2.3 实现天气候选正文验收和验收前流式暂存
- [x] 2.4 在 Demo Server 启动时执行恢复扫描并输出安全摘要

## 3. 场景化验证

- [x] 3.1 实现 `runtime-scenario.v1` 版本化场景协议和不包含业务分支的通用 Runner
- [x] 3.2 增加 ToolResult 提交后进程退出并成功恢复的天气场景
- [x] 3.3 增加模型候选缺少来源而被系统拒绝的天气场景
- [x] 3.4 将同一场景资产接入 `deterministic` 与 `real-model`，并将 setup 与 evaluation 证据分开报告
- [x] 3.5 真实模式强制显式模型别名并只调用现有 Gateway 主链；失败直接记录且不回退固定模型

## 4. 文档与验证

- [x] 4.1 同步 README、场景链路、上下文边界和决策索引
- [x] 4.2 运行相关测试、全量测试、Skill 校验和 OpenSpec strict 校验
- [x] 4.3 执行 `gpt-5.6` 单样本真实观察并如实记录上游连接超时；样本不足 30 不建立质量基线

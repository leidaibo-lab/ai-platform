# 天气重启恢复通过场景

setup 使用固定行为模型调用一次 `get_weather`，在 Runtime 已提交 completed ToolResult 后以退出码 `86` 直接结束。evaluation 打开同一 SQLite，只根据持久化 ToolResult 生成最终总结；恢复期 Connector 是禁止调用的哨兵。该场景同时支持 `deterministic` 和 `real-model`，后者只在 evaluation 阶段调用真实 Gateway 主链。

独立验收检查原 Run 完成、消息没有重复、工具事件只有一次开始和一次完成、AcceptanceResult 为 accepted，并且 resilience 明确记录 `process-restart-after-tool-result`。固定模型通过只证明 Runtime 恢复链；真实模式少于 30 个样本时只作质量观察。两种模式都不证明多实例恢复。

# 天气重启恢复拒绝场景

中断阶段与通过场景相同，先提交一次真实 Runtime ToolResult 再结束进程。恢复模型故意返回包含地点、时间和温度但缺少来源的候选正文。

独立验收要求原 Run 以 `result_acceptance_rejected` 失败、候选正文没有成为助手消息、AcceptanceResult 明确记录 `weather_source_missing`，且恢复没有再次执行 Connector。该场景验证“模型说完不等于系统接受完成”。

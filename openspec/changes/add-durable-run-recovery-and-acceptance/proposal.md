## Why

当前 Runtime 已能持久化 Conversation、Run、Message 和 ToolResult，也能在同一进程、同一 Run 内从 completed ToolResult 恢复最终总结，但进程在 ToolResult 提交后退出时，Run 会永久停留在 `running`。同时，天气回答是否包含地点、数据时间、来源和真实工具证据仍主要依赖模型，Run 的 `completed` 只表示模型返回，不表示系统独立验收通过。

需要先选取一个边界稳定、无副作用的恢复点，把“状态能保存”推进为“执行能从稳定提交点恢复”，并把“模型返回完成”推进为“系统根据持久化证据接受完成”。首期使用天气只读工具结果后的最终总结阶段验证该思想，不把局部恢复扩张为通用工作流引擎。

## What Changes

- 为 Run 持久化原始绝对截止时间和 ChainTrace ID，供进程重启后判定恢复资格并延续业务关联。
- Runtime 启动时扫描遗留 `running` Run；只恢复已提交全部只读 ToolResult、尚无助手消息且原截止时间未耗尽的最终总结阶段。
- 图片生成、无稳定 ToolResult、运行中或失败工具、未知工具、写操作和已超时 Run 不自动重放，统一收口为明确失败事实。
- 新增持久化 `AcceptanceResult`。天气回答必须独立通过地点、数据时间、来源和至少一个结果事实绑定检查，才能写入助手消息并进入 `completed`。
- 需要系统验收的流式回答先在 Runtime 内暂存；验收通过后才向渠道放行，验收拒绝时不得交付候选正文。
- 受管工具只在 Runtime 确定性路由命中后向模型开放；必需 ToolResult 缺失时模型正文不得自行完成 Run。
- 验收终态提交后的渠道投递失败不得反向改写或误报 Run 执行状态，渠道可通过幂等重放或 `latestRun` 取回结果。
- 新增版本化 Runtime Scenario 协议和双模式 Runner，把场景输入、脚本化模型决策、故障注入、独立验收和证据采集分离；同一场景可运行 `deterministic` 链路回归与 `real-model` 质量观察。
- 真实模式先用固定行为模型构造 ToolResult 已提交的稳定故障点，再只通过现有 `GatewayClient -> AI SDK -> LiteLLM -> 上游模型` 完成重启总结；真实调用失败必须直接失败，不得回退固定模型。

## Capabilities

### New Capabilities

无。执行恢复与结果验收属于现有 `ai-platform` Agent Runtime 和治理能力的增量，不新增服务级 spec。

### Modified Capabilities

- `ai-platform`：扩展 Run 持久化、进程重启恢复、最终结果接受条件，以及可版本化、可跨项目适配的双模式场景评测契约。

## Impact

- Agent Runtime：遗留 Run 分类、ToolResult 总结恢复、验收门禁和流式暂存。
- SQLite：Run 恢复元数据和 `AcceptanceResult` 事实。
- Demo Server：监听端口前执行一次启动恢复扫描并报告结果。
- 测试与治理：增加可独立运行的故障场景、应用验收和分模式报告；固定模型结果与真实模型质量严格分开统计。
- 兼容性：普通 C1 对话和 C2 图片生成仍使用现有请求结构；只有命中天气确定性工具路由的回答增加系统验收门禁。

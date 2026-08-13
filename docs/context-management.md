# 上下文管理

V0.6 已将会话事实源从浏览器迁移到 Agent Runtime；当前 V1 天气切片继续复用这套事实源，把 completed ToolResult 作为首个可恢复执行稳定点。浏览器、IM 和 API Adapter 只提交 `conversationId`、幂等标识和当前输入；Runtime 持久化完整消息，维护结构化记忆，并为每次 Run 或受限恢复构造预算内上下文。

## 核心链路

```text
渠道当前输入
  -> Session / Run API
  -> SQLite 先写用户消息
  -> Context Planner
      -> active 结构化记忆
      -> 相关 Episode
      -> 最近未压缩消息
      -> 模型路由 token 计数
  -> Model Gateway
  -> [按需] ToolResult 稳定提交点 / 无工具总结恢复
  -> [按需] 独立 Acceptance Policy
  -> SQLite 原子写 AcceptanceResult、助手消息、usage 和 Context Manifest
  -> Memory Manager 按水位异步更新记忆
```

## 数据所有权

| 数据 | 写入所有者 | 说明 |
| --- | --- | --- |
| `conversations`、`runs` | Agent Runtime | 会话状态、幂等和执行结果 |
| `messages` | Agent Runtime | 完整原始事实源，只追加不因压缩删除 |
| `tool_calls` | Agent Runtime | 工具调用、状态、结构化 ToolResult、来源和数据时间 |
| `acceptance_results` | Agent Runtime | 与 Run 一对一的策略、版本、接受或拒绝结论和最小证据 |
| `memory_items` | Memory Manager | 目标、约束、偏好、事实、决策和任务 |
| `memory_versions` | Memory Manager | 每次 MemoryDelta、来源区间、模型和 usage |
| `episode_summaries` | Memory Manager | 连续消息区间的情节摘要 |
| `conversation_events` | Agent Runtime | 多标签页 SSE 增量游标 |

模型网关只接收本轮选中的上下文，不保存业务会话或记忆。

## 结构化记忆

Memory Extractor 只生成增量操作，确定性 Reducer 负责合并：

```json
{
  "upserts": [
    {
      "type": "fact",
      "entity": "current-project",
      "key": "message-queue",
      "value": "Kafka",
      "reason": "需要事件回放",
      "itemStatus": "active",
      "priority": "critical",
      "sourceMessageIds": ["message-id"]
    }
  ],
  "supersedes": [
    { "type": "fact", "entity": "current-project", "key": "message-queue", "sourceMessageIds": ["message-id"] }
  ],
  "episode": {
    "topic": "消息队列决策",
    "summary": "用户将消息队列从 RabbitMQ 更正为 Kafka。",
    "sourceMessageIds": ["message-id"]
  }
}
```

旧事实保留为 `superseded`，新事实成为 `active`。每条记忆必须带原始消息来源，长期漂移时可以从 `messages` 重建。

## Context Planner

Planner 按以下顺序分配输入预算：

1. 系统、安全、权限和当前输入，强制保留。
2. active 的关键目标、约束、最新纠正、决策和未完成任务。
3. 与当前问题词法相关的旧 Episode。
4. 最近未压缩的完整 user/assistant 消息。
5. 超出预算的低优先级候选完整排除，不从字符串中间硬截断。

每次 Run 返回 Context Manifest，记录 token 预算、实际计数器、入选 ID、排除 ID和水位状态。

## 高低水位

默认策略：

```text
maxContextTokens       12000
reservedOutputTokens    2000
safetyTokens             500
high watermark            75%
low watermark             45%
hard watermark            90%
```

水位只计算尚未压缩的原始消息窗口。达到高水位后，Memory Manager 从最老的完整对话轮次开始提取，直到保留窗口降到低水位；接近硬水位时在回答前同步压缩。

## 并发与幂等

- `requestId` 保证同一个 Run 重试不会重复调用模型。
- `clientMessageId` 保证用户消息不会因网络重试重复写入。
- Conversation Coordinator 在单进程内按 `conversationId` 串行 Run，不阻塞其他会话。
- Memory Manager 调用模型时不持有数据库事务。
- 提交 MemoryDelta 时使用 `memoryVersion + summarizedThroughSeq` compare-and-set；旧任务提交失败后重新读取或幂等结束。
- 用户和助手消息同步落库，记忆压缩异步最终一致；关闭会话时执行最终 checkpoint。

当前稳定部署边界仍是“同一时刻只有一个 Runtime 实例服务多个标签页或客户端”。单实例进程重启后会扫描遗留 Run，但只从原截止时间内、全部工具均为 completed 已注册只读调用、无助手消息的稳定点继续最终总结；运行中工具、失败工具、图片、写操作和未知副作用明确失败。横向扩为多个 Runtime 实例前，需要在共享数据库增加带 `conversationId`、`ownerId`、`expiresAt` 和 fencing token 的 Run lease，或改用按会话分区的消息队列；只有取得 lease 的实例才能调用模型和提交回答。`memoryVersion` 乐观锁继续负责压缩结果冲突，但不能替代 Run lease。

## 评测

`node .agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs` 使用内存 SQLite 和确定性脚本模型运行 100 轮场景：

- 第 1 轮：当前项目使用 RabbitMQ。
- 第 45 轮：更正为 Kafka，原因是需要事件回放。
- 第 70 轮：Alpha 项目仍使用 RabbitMQ，制造相似实体干扰。
- 第 80 轮：记录 Kafka 主题权限配置待办。
- 第 100 轮后：验证最新纠正、实体隔离、待办状态和来源追溯。

场景数据位于 `.agents/skills/docs/context-memory-evaluation/assets/fixtures/`，runner 通过 `--fixture` 加载对话、MemoryDelta、隐藏探针和指标；新增场景不得修改 runner 业务分支。

真实模型上线前还应使用固定模型版本重复运行同一 fixture，增加准确率、token、费用和延迟的 A/B 报告。

进程故障与结果验收使用独立的 `scenarios/runtime/` 版本化资产和通用 Runner。`npm run eval:runtime-scenarios:deterministic` 使用固定行为模型验证 SQLite、恢复和判分链路；项目级真实评测命令固定使用 `gpt-5.6`，独立调用或其他 AI 项目装配时仍通过 `--model` 显式固定自己的模型别名。setup 使用固定模型构造稳定点，evaluation 才通过现有 Gateway 主链调用目标别名。两阶段请求、完成、失败、token 和耗时分开记录，真实失败不回退固定模型。真实样本不足 30 时只报告观察结果，不把脚本模型或单样本通过率写成真实准确率。

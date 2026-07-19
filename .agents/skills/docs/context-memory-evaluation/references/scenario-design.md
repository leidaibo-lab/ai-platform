# 上下文记忆场景设计

## 场景组成

每个 fixture 至少包含：初始事实、明确纠正、长距离噪声、相似实体干扰、隐藏探针和结构化标准答案。涉及任务时补充 pending、completed 或 cancelled 状态变化。

fixture 统一放在 `assets/fixtures/`。新增场景时只增加 JSON，不修改 `scripts/run-deterministic-eval.mjs`。JSON 至少声明：

- `turnCount`、`checkpointEvery` 和带 `{{turn}}` 的默认噪声模板。
- 特殊轮次 `events`，以及对应的确定性 `memoryDelta`。
- 不出现在运行对话中的隐藏 `probe` 与标准答案。
- 使用 `probe-and-memory`、`memory`、`memory-absent` 或 `all-active-sources` 的指标列表。

## 干扰类型

| 类型 | 示例目的 |
| --- | --- |
| 不同纠正表达 | 覆盖“之前说错了”“以此为准”“不是 A，是 B” |
| 历史引用 | 防止旧提案或引用材料被识别为当前决定 |
| 假设语句 | 防止“如果以后改回 A”覆盖当前事实 |
| 否定语句 | 检查模型是否正确处理“不要使用 A” |
| 相似实体 | 检查项目、人、环境和版本之间是否串线 |
| 多次纠正 | 检查 A -> B -> C 后是否只保留 C 为 active |
| 任务状态变化 | 检查 pending -> completed/cancelled |
| 中英文和简称 | 检查同义表达、缩写和代词解析 |

## 防止答案泄漏

- 将 gold memory 和 probes 保存为 fixture 元数据，不拼入运行对话。
- 使用与原始事实不同的隐藏提问表达。
- 不在 fixture ID、会话标题或系统提示中写最终答案。
- 比较模型时复用同一 fixture 版本，不临时修改问题适配某个模型。
- fixture Gateway 只读取 fixture 声明的 delta 和 probe，不按业务关键词写条件分支。

## 分层规模

- 日常 smoke：5 个案例，每个 30 轮。
- PR 回归：20 个案例，每个 50 轮。
- 发布评测：至少 100 个案例，每个 100 轮。

真实模型评测成本较高，应先运行确定性评测确认 harness、Reducer 和判分器正常，再启动真实模型套件。

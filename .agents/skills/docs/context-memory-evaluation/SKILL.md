---
name: "docs-context-memory-evaluation"
description: "上下文记忆评测场景的创建、执行和回归治理。用于新增或调整长期对话 fixture、运行多轮确定性评测、设计真实模型评测、比较模型或 Prompt/Memory 策略，或将线上记忆问题沉淀为回归案例。"
metadata:
  pattern: "pipeline"
  author: "ai-platform"
  version: "1.1.0"
---

# 上下文记忆评测

## 执行原则

- 先区分确定性 Runtime 回归和真实模型评测；不得用脚本模型结果代表真实模型准确率。
- 将标准答案与对话输入分离；隐藏探针不得提前出现在对话中。
- 优先直接校验结构化记忆、状态和来源 ID；只有自由文本答案无法确定性判断时才使用独立 Judge。
- 固定模型别名、Prompt 版本、采样参数、checkpoint 策略和 fixture 版本，保证结果可比较。
- 将失败案例缩减成最小 fixture 并永久保留，禁止只修改阈值掩盖回归。

## 工作流

1. 读取 `docs/context-management.md`、当前 Runtime 实现和已有评测脚本，确认本次行为边界。
2. 选择评测类型：逻辑变更先跑确定性评测；模型、Prompt 或提取策略变更再跑真实模型评测。
3. 按 `references/scenario-design.md` 新增 fixture，禁止把场景消息或标准答案写进 runner。
4. 按 `references/metric-definition.md` 定义分子、分母、失败条件和发布阈值。
5. 执行对应脚本，记录 checkpoint、记忆版本、水位、准确率、token、费用和延迟。
6. 对失败项检查原始消息、MemoryDelta、active/superseded 状态、Context Manifest 和最终回答。
7. 新增或调整 fixture 后同步更新使用文档；改变稳定 Runtime 行为或发布契约时再更新 OpenSpec。

## 确定性评测

运行当前 100 轮上下文记忆回归：

```bash
node .agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs
```

运行指定 fixture：

```bash
node .agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs \
  --fixture .agents/skills/docs/context-memory-evaluation/assets/fixtures/message-queue-correction-100.json
```

runner 只读取 fixture、驱动 Runtime 和执行通用指标，不得包含具体业务场景。fixture 负责声明轮次事件、MemoryDelta、隐藏探针和指标。该评测使用内存 SQLite 和 fixture Gateway，只验证 Runtime、Reducer、Planner、checkpoint 和判分链路。

## 真实模型评测

- 使用真实 `createLiteLlmClient()` 装配独立 Runtime，不得导入脚本 Gateway。
- 每个 fixture 使用独立数据库，避免案例之间共享会话和记忆。
- 日常 smoke、PR 回归和发布评测使用不同规模，避免每次变更都执行高成本全量套件。
- 真实模型 runner 落在本 Skill 的 `scripts/`，并复用 `assets/fixtures/` 中不含脚本答案分支的对话输入和标准答案。
- CI 直接调用 Skill 脚本，不要求 Codex 参与执行。

## 输出结论

- 明确区分“确定性链路通过”和“真实模型准确率达到阈值”。
- 准确率必须显示为 `通过数/总数` 和百分比，不得只写“效果良好”。
- 同时报告旧事实泄漏率、实体隔离准确率、任务状态准确率和来源有效率。
- 真实模型报告补充模型别名、实际模型、Prompt 版本、总 token、估算费用、平均延迟和 P95 延迟。

## 校验

修改 Skill 或脚本后运行：

```bash
node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs
node --check .agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs
node .agents/skills/docs/context-memory-evaluation/scripts/run-deterministic-eval.mjs
```

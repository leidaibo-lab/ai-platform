## Design

`role-execution.v1` 由宿主在角色模型调用后生成，作为产品、开发、测试和发布角色共享的执行事实基座；每个角色再附加带 `kind` 的严格专属扩展。它不改变角色正文、人工审批或下游交接协议。

```text
Mastra product role
  -> product generation result
  -> role-execution.v1 + role extension
  -> product/development/quality/release artifact
  -> readIntake() diagnostic projection
  -> web DiagnosticTrace
```

公共字段包含：阶段目标、输入引用、模型调用统计、工具事实、输出摘要、发现、失败尝试、阻塞原因和下一步。角色扩展分别承接产品需求假设与待决问题、开发任务与文件检查点、测试用例与质量计数、发布环境与部署健康和回滚引用。

不同角色不得通过公共字段堆叠专属属性，也不得退化为无约束 `metadata`；新增角色应新增版本化扩展 Schema，并保持公共基座可被统一投影。

`execution-control` 仍是进程内实时取消观察，不承担历史诊断。Workflow 快照是当前开发/测试阶段的唯一持久化事实源。

## Security and privacy

- 工具参数只保存 Hash，不保存原始参数。
- 工具结果只保存调用事实，不保存原始返回正文。
- 模型输出只保存正文已有的结构摘要、长度和 Hash。
- 不记录模型隐藏推理或未脱敏异常正文。

## Explicit non-goals

- 不把阶段摘要伪装成 findings/decisions 业务实体；完整业务分析结构化输出另行设计。
- 不建设独立事件表、跨实例事件流或旧历史 Run 迁移。

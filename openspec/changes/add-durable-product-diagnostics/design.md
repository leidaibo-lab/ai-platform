## Design

`product-diagnostic.v1` 由宿主在角色模型调用成功后生成。它不改变角色正文、人工审批或下游交接协议。

```text
Mastra product role
  -> product generation result
  -> product-diagnostic.v1
  -> productWork.entries[].diagnostic
  -> readIntake() diagnostic projection
  -> web DiagnosticTrace
```

诊断字段包含：阶段目标、需求 Hash、来源引用、前置角色、需求轮次、模型标识、尝试次数、步骤数、finish reason、token 统计、工具名称/参数指纹/返回状态/重复次数、正文 Hash、正文长度、标题结构、失败尝试和下一步。

`execution-control` 仍是进程内实时取消观察，不承担历史诊断。Workflow 快照是当前开发/测试阶段的唯一持久化事实源。

## Security and privacy

- 工具参数只保存 Hash，不保存原始参数。
- 工具结果只保存调用事实，不保存原始返回正文。
- 模型输出只保存正文已有的结构摘要、长度和 Hash。
- 不记录模型隐藏推理或未脱敏异常正文。

## Explicit non-goals

- 不把阶段摘要伪装成 findings/decisions 业务实体；完整业务分析结构化输出另行设计。
- 不建设独立事件表、跨实例事件流或旧历史 Run 迁移。

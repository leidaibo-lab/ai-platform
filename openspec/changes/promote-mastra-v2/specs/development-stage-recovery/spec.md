## ADDED Requirements

### Requirement: Recover an unimplemented architecture checkpoint after a recognized infrastructure replay failure

系统 SHALL 仅对发生在架构生成节点、尚无实施副作用且仍能核验同一 Run 批准产品、执行身份与候选源码检查点的已知缓存回放失败提供受控恢复。

#### Scenario: Recover a stale architecture-cache replay failure

- **WHEN** 架构节点因旧同步缓存回放暂停包导致结构校验失败，且产品批准、上下文、候选源码和执行身份均未漂移
- **THEN** 系统 SHALL 展示该失败为缓存兼容问题，并只从原架构检查点重新进入技术方案生成
- **AND** 恢复 SHALL 不重做产品、项目范围或上下文分析，不批准方案，不执行实现或远端写入

#### Scenario: Unsafe architecture checkpoint

- **WHEN** 检查点已有实施、测试、发布副作用，或产品、执行身份、候选源码和上下文任一不一致
- **THEN** 系统 SHALL 拒绝恢复，不重放缓存，不调用模型，不改写批准事实

### Requirement: A suspended architecture cache is not a reusable architecture result

系统 SHALL 将远端同步缓存中的 `suspend` 与已生成的 `result` 区分处理。

#### Scenario: Resume from a model recovery decision

- **WHEN** 架构节点收到原生恢复决定且同一缓存文件保存的是 `suspend`
- **THEN** 系统 SHALL 回到架构节点消费恢复决定
- **AND** 不得将暂停包解析为架构方案或资料同步结果

#### Scenario: Preserve a historical suspend cache during recovery

- **WHEN** 同一架构输入已经存在 `suspend` 缓存且恢复决定重新产生阶段检查点
- **THEN** 系统 SHALL 为恢复轮次使用派生缓存键并保留历史暂停记录
- **AND** 不得因缓存键冲突使恢复后的工作流失败

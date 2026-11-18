## ADDED Requirements

### Requirement: Recover the historical product-anchor initialization failure

系统 SHALL 仅对旧版产品锚点数量限制导致的开发初始化失败提供受控恢复，复用同一 Mastra Run 的已批准产品和项目快照，不自动批准方案或实施。

#### Scenario: Recover an unchanged pre-implementation checkpoint

- **WHEN** 开发初始化因旧版锚点预算失败，产品批准与项目范围输入一致，且后续开发、测试和发布未执行
- **THEN** 系统 SHALL 展示失败原因、保留成果、恢复动作及模型费用影响
- **AND** 恢复时 SHALL 再次核对版本令牌、模式、原始候选存在及其内容散列，并从固定的开发执行入口恢复
- **AND** 方案仍须经过原有人工批准和工程准备门禁

#### Scenario: Changed or unsafe checkpoint

- **WHEN** 产品批准、项目快照、候选源码或运行状态不一致，或下游已开始
- **THEN** 系统 SHALL 拒绝恢复且不得重建候选、执行模型或改写批准

#### Scenario: Repeated recovery submission

- **WHEN** 单个服务进程内相同 Run 的恢复请求并发或令牌过期
- **THEN** 系统 SHALL 拒绝重复启动，不自动重放外部写入

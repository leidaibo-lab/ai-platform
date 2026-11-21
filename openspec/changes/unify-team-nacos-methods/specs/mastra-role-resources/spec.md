## ADDED Requirements

### Requirement: All team methods use a frozen Nacos catalog

启用 Nacos 的新 live 主线 Run SHALL 冻结产品、研发、测试、浏览器 QA 和共享方法的角色与任务 Prompt、Skill、references、绑定、精确版本和摘要。调用前 SHALL 复核原版本，缺失或漂移 SHALL 失败关闭；权限、Schema、预算、审批和运行事实 SHALL 继续由宿主持有。

#### Scenario: Defaults change after a pause

- **WHEN** Run 暂停后默认方法发布新版本
- **THEN** 各团队 SHALL 继续读取原冻结目录，不得取最新版本替代
- **AND** 研发批准、恢复、测试和浏览器证据 SHALL 绑定实际方法身份

#### Scenario: Historical resources remain unchanged

- **WHEN** 历史 Run 没有全团队目录
- **THEN** 系统 SHALL 保留原方法与批准语义，不伪造远端冻结事实
- **AND** 离线候选导出 SHALL 不发布资源或修改环境

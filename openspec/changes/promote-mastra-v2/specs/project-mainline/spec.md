# project-mainline Specification

## ADDED Requirements

### Requirement: Root defaults to the complete Mastra application

仓库根目录 SHALL 以完整 Mastra 应用作为默认开发、测试、构建和工作台入口，并保留远端
`origin/main` 基线中的需求入口、Run 状态、时间线、人工关口和 Workflow 能力。

#### Scenario: Maintainer uses root application commands

- **WHEN** 维护者在仓库根目录执行主应用脚本
- **THEN** 脚本 SHALL 使用根目录的 Mastra 依赖、`src/`、`web/` 和 `config/`
- **AND** SHALL NOT 依赖 `practices/mastra/` 作为运行源码目录

### Requirement: Custom exploration remains isolated

原自研 Runtime、Demo、LiteLLM、场景和实验 SHALL 位于
`practices/custom-exploration/`，并独立持有其依赖、配置、环境样例和稳定契约。

#### Scenario: Mainline runs without the custom Runtime

- **WHEN** 根 Mastra 应用启动或执行测试
- **THEN** 主线源码 SHALL NOT 导入探索 Runtime、GatewayClient 或探索 SQLite Store
- **AND** 主线数据目录 SHALL NOT 成为探索实践的数据目录

### Requirement: Mastra Store remains the execution fact owner

Workflow 执行、审批和恢复事实 SHALL 由 Mastra Store 持有。时间线、SSE 活动流、文件和工具
摘要 SHALL 是安全的只读投影，不能成为第二事实源。

#### Scenario: Workbench reads execution activity

- **WHEN** 工作台展示 Run 时间线或接收活动通知
- **THEN** 页面 SHALL 从原生 Workflow 快照和受控事件读取公开元数据
- **AND** SHALL NOT 接收模型隐藏推理、密钥、工具结果正文或任意文件内容

### Requirement: Model failure diagnostics state only their recorded scope

工作台和恢复关口 SHALL 依据已保存的白名单诊断展示单次模型调用的失败来源，不得将上游 HTTP 响应错误表述为用户本地网络故障、模型服务整体不可用或模型配置无效。

#### Scenario: Upstream gateway returns a 5xx response

- **WHEN** 已保存诊断的失败来源为 `upstream-http` 且包含 HTTP 5xx 状态码
- **THEN** 页面 SHALL 展示“上游模型网关返回 HTTP <状态码>”
- **AND** 对 408、504 或 524 SHALL 额外说明该请求超时
- **AND** SHALL 保留检查点和重试入口，不暴露上游地址、请求正文、响应正文、认证信息或模型隐藏推理

### Requirement: Late business gaps re-enter controlled clarification

测试或发布阶段发现业务未闭环时，主 Workflow SHALL 保留阶段证据、进入产品澄清和修订确认，
并且只在新产品版本确认后重新规划及回归。

#### Scenario: QA returns a business finding

- **WHEN** QA 质量审阅提交 `business` 类或 `product` 路由发现
- **THEN** 系统 SHALL 保留 QA 历史而不是进入普通开发返工
- **AND** SHALL 将发现转为必须回答的产品澄清项
- **AND** 修订产品确认后 SHALL 使旧研发、QA 与发布版本失效并重新执行后续阶段

#### Scenario: Release health returns a business finding

- **WHEN** 发布后健康报告带有 `business` 类或 `product` 路由发现
- **THEN** 系统 SHALL 保留发布和健康证据，并先完成所需回滚关口
- **AND** SHALL 按与 QA 相同的澄清、确认、重新规划和回归路径继续

### Requirement: Formal specifications use one capability-named Run branch

已确认的需求文档、产品 Spec、开发 Spec 与测试 Spec SHALL 由系统在同一个远端 Run 分支
追加提交和推送。分支名 SHALL 是 `run/<主要能力>-<runId>`，不允许客户端提供 Git ref、目标
分支或推送地址。

#### Scenario: A confirmed stage publishes a formal specification

- **WHEN** 对应阶段的人工确认通过
- **THEN** 系统 SHALL 使用独立 index 创建仅包含该阶段制品的不可变提交并校验远端分支
- **AND** SHALL 将分支、commit、文件散列和上游提交绑定保存到 Workflow 状态
- **AND** SHALL NOT 向默认分支或新的阶段分支推送

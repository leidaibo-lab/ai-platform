## ADDED Requirements

### Requirement: Team configuration view and controlled default
平台 SHALL 向已登录工作台账号提供团队配置的白名单视图，标明值、权威来源、可调整性和适用范围；不得返回凭据或将资源盘点当作运行配置。平台 SHALL 允许该账号通过本机工作台设置研发技术接续默认次数，校验为 0 至 72 的整数，并持久化在当前数据目录。未设置时使用服务端环境配置及其既有默认值。

#### Scenario: Default changes before development initialization
- **WHEN** 已登录账号保存合法的研发技术接续默认次数，且研发阶段尚未初始化
- **THEN** 后续研发初始化读取该值并将其写入 Workflow 状态；已有技术接续状态和显式继承预算保持不变

#### Scenario: Reject unauthorized or invalid updates
- **WHEN** 请求没有有效工作台会话、来源不允许或设置值不合法
- **THEN** 服务端拒绝更新并保留既有配置

#### Scenario: Present protected settings
- **WHEN** 用户查看模型时限、方法和工程检查等尚未接入页面修改的设置
- **THEN** 页面标明来源及只读状态，不声称其可以通过页面修改

### Requirement: Configure startup model selection
平台 SHALL 允许已登录工作台账号设置默认模型及产品、研发模型覆盖，保存到同一数据目录；校验模型标识为 `openai/` 前缀且不含空白。模型变更 SHALL 在服务重启后装配生效；页面 SHALL 区分当前运行值和待生效值，并说明研发旧 Run 可能因模型身份漂移拒绝恢复。fixture 模式继续使用固定样例模型。缺省覆盖沿用环境配置。页面不得保存凭据，不承诺验证模型可用性。

#### Scenario: Save model selection
- **WHEN** 用户提交合法模型配置
- **THEN** 系统保存待生效值，当前进程继续使用启动时模型；重启后按保存值装配

#### Scenario: Reject invalid model selection
- **WHEN** 用户提交非法模型标识或未经授权的请求
- **THEN** 系统拒绝保存并保持原配置

### Requirement: Independent team model values
产品、研发和测试团队 SHALL 分别拥有独立模型值；平台默认模型为旧配置及首次初始化提供初值，不作为团队页面的共享可编辑字段。首次保存团队模型时 SHALL 将其他尚未显式设置的团队模型按当时有效值一并固化，后续修改一个团队不得改变其他团队。旧设置 SHALL 按原先回退语义解析，直到显式保存新的团队模型值。

#### Scenario: Change testing team model
- **WHEN** 管理员保存测试团队模型
- **THEN** 重启后测试角色使用该模型，产品和研发团队保持各自已保存或初始化的模型值

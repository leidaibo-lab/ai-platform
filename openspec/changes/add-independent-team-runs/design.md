# 设计草案

## 统一运行输入

所有独立团队 Run 使用 `team-run-input.v1` 信封，外层固定团队 ID、项目 ID、迭代 ID、来源引用及团队载荷版本。输入包采用严格 discriminated union；服务端按团队读取来源，不接受客户端提供的权威正文、批准状态、Git 身份、候选目录或命令。

## 来源类型

- `product`: 原始需求或经确认的需求材料。
- `development`: 当前项目内已批准产品产物，或经校验确认的产品输入包。
- `testing`: 当前项目内研发交付与固定候选检查点，或经校验确认的候选输入包。
- `delivery`: 当前项目内通过质量门的测试结果。交付不提供“手工通过”来源。

读取既有 Run 时，服务端从 Store 与固定仓库回执重新解析来源，形成不可变快照。Run 恢复使用创建时冻结的来源和 Adapter 身份。

## 装配边界

独立 Run 使用独立的 Mastra Workflow ID 与 Run ID；来源 Run 仅作为有版本的只读上游引用。团队之间继续通过 `team-run-envelope.v1` 和 `rework-request.v1` 交互。团队回归测试直接启动团队 Workflow 并使用隔离 Store/固定输入；集成测试仍从 `product-development` 验证交接。

实现时需先泛化现有项目绑定校验。当前绑定代码将 `workflowId`、初始化快照路径和 Store 查找固定为 `productDevelopmentWorkflow`，不能直接给内部嵌套 Workflow 增加 HTTP 入口。

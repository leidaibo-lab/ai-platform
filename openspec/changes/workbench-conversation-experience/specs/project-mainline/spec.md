## MODIFIED Requirements

### Requirement: Review the current decision without leaving the requirement

工作台 SHALL 在主栏以节点对话流展示快照中已有的执行记录和当前人工操作，流程导航与材料按需展示。

#### Scenario: Read node activity and locate a topic

- **WHEN** 用户查看运行记录
- **THEN** 工作台 SHALL 按快照顺序展示已开始节点、状态及可用检查、工具和文件，不臆造节点任务描述或最终总结
- **AND** 可确定归属的当前页面会话公开流 SHALL 显示在对应节点，未能确定归属的流 SHALL 单独标识
- **AND** 运行中公开流默认展开，结束后可折叠；流不代表已批准产物，断线与刷新不保证历史流可回放
- **AND** 连接中、等待输出和连接中断 SHALL 在对话流中明确提示；结构化需求分析的工具生命周期可实时展示，未校验的结构化正文不得作为已确认结果展示
- **AND** 遗留写作恢复入口 SHALL 收纳在运行对话中，保留服务端时限和身份校验
- **AND** 用户可通过节点导航定位记录，当前阅读位置可辨识
- **AND** 人工关口、失败诊断、恢复及材料入口 SHALL 保留，状态和审批以服务端快照为准

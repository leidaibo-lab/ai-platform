## ADDED Requirements

### Requirement: Studio 独立研发对话角色

Studio SHALL 注册研发负责人、研发实施者及研发审查者三个独立对话 Agent，使用研发团队模型配置，无需已有 Run 即可处理用户提供的材料。Agent SHALL NOT 自动装配项目 Workspace、仓库读写或执行工具；输出 SHALL 区分建议与实际执行、检查、审批或交付事实。

三个角色 SHALL 使用宿主 Store 支持独立对话记忆，并分别装配受治理的只读研发方法 Skill。方法仅指导分析，不授予仓库、执行或审批权限；业务未决规则 SHALL 标为待确认，不能作为已批准验收或实施事实。

#### Scenario: 无 Run 进行研发对话

- **WHEN** 用户在 Studio 选择任一研发 Agent 并提供材料
- **THEN** Agent SHALL 使用研发模型基于所提供材料响应，无需现有 Run 或项目绑定

#### Scenario: 未提供仓库上下文

- **WHEN** 用户要求分析或修改项目但未提供相应材料
- **THEN** Agent SHALL 说明缺少的上下文，不能声称已读取仓库、修改文件或执行检查

## ADDED Requirements

### Requirement: Independent development evaluation starts from direct requirements

研发独立评测 SHALL 接收需求正文和服务端登记的项目身份，不要求产品 Run、产品审批或产品正式规格回执。系统 SHALL 在 Mastra Store 冻结需求正文、内容散列、项目绑定和评测来源，拒绝客户端提供仓库路径、执行命令或伪造产品批准。历史来源型 Run SHALL 按其原版本恢复。

#### Scenario: Run the development team from direct input

- **WHEN** 用户提交研发需求并启动独立评测
- **THEN** 系统 SHALL 使用研发团队的项目授权、规划、方案授权、实施、检查、评审与交付流程
- **AND** 评测授权和研发交付 SHALL 标识评测用途，SHALL NOT 表示产品批准、生产验收或真实远端交付
- **AND** 恢复 SHALL 校验冻结输入及项目和 Adapter 身份

#### Scenario: Record actual live evaluation results

- **WHEN** 独立研发评测使用 live 模型运行
- **THEN** 报告 SHALL 区分真实模型、受控检查、人工或评测授权及远端回执，并记录实际停点和未验证范围

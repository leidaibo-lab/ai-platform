# 研发团队独立评测案例

`hrm-candidate-follow-up.json` 绑定需求正文、项目和迭代；正文中的待确认项是评测输入，不代表已确认业务规则。

在配置好 live 模型、项目和 Nacos 资源后，执行：

```sh
MASTRA_MODE=live MASTRA_LOCAL_TRACE=false npx tsx scripts/development-team-evaluation.ts evaluations/independent-teams/cases/hrm-candidate-follow-up.json
```

脚本使用独立 Store 启动同一研发团队 Workflow，输出结果和数据库目录。首次执行在项目范围授权等关口暂停，不自动伪造授权；后续执行需使用对应原生关口恢复。真实模型、检查和研发交付以实际 Run 状态为准，不能把启动或暂停当作闭环通过。远端写入需单独授权。

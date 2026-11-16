# Mastra 主线评测

本目录保存根 Mastra 应用的可复跑评测与结果记录。评测按用途分层，不能以 fixture 结果替代真实模型质量、真实工程执行或生产验收。

| 目录 | 内容 |
| --- | --- |
| `development/` | 研发阶段、固定案例与全栈候选验证 |
| `native/` | 原生 Workflow、开发节点与评审返工评测 |

运行入口由根 `package.json` 提供，例如 `npm test`、`npm run eval:development`、`npm run eval:unified` 和 `npm run eval:development-nodes`。使用 fixture 或专用临时数据目录运行；真实模型、Docker、远端仓库或费用相关验证必须显式声明。

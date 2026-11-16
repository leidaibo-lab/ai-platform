# 探索实践集合

根目录是 AI 应用基础平台 v2.0 的 Mastra 主线。`practices/` 仅保存不参与主线运行的探索与学习项目；它们独立管理依赖、配置、数据、端口和验证证据，不能被根应用默认导入。

| 实践 | 目标 | 当前状态 |
| --- | --- | --- |
| [custom-exploration](./custom-exploration/README.md) | 保留并研究原自研 Runtime、Demo、LiteLLM、场景和 pi 适配实验 | 独立探索，不构成 Mastra 主线能力 |
| [pi](./pi/README.md) | 按 pi 自身方式理解 Agent、编码任务和执行生命周期 | 学习入口；尚无本目录原生运行应用 |

## 与主线的边界

- 根 `src/`、`web/`、`config/`、`tests/`、`evaluations/` 和根依赖属于 Mastra 主线。
- `custom-exploration` 保留其自研 Runtime、GatewayClient、SQLite Store、Demo 和 LiteLLM 配置；它们不得作为主线依赖或能力证据。
- 新增探索实践时，先在本目录建立自己的 README、`.gitignore`、依赖锁、无密钥环境样例和数据目录约束。
- 任何探索能力要进入主线，必须另行形成 OpenSpec、实现与验证；目录共存不代表能力已经迁移。

真实模型调用、外部写入和部署均须按各实践的局部规则显式授权。

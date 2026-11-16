# 探索实践协作规则

本目录只承载独立探索和学习项目。根目录的 Mastra v2.0 应用不在这里运行；主线规则见仓库根 `AGENTS.md`。

- 每个实践独立持有依赖、lockfile、环境样例、数据目录、端口和构建输出忽略规则。
- 不读取、打印或提交真实密钥；不复制主线 `.env` 或数据目录。
- 不将实践 Runtime、GatewayClient、SQLite Store、Demo 或测试结果自动计入根 Mastra 主线。
- 探索中形成的稳定行为需要进入主线时，先在根 OpenSpec 中定义，再显式实现和验证。
- 保持中文协作、函数职责注释、必要的 JSDoc，以及 `type(scope): 中文说明` 提交规范。

`custom-exploration/AGENTS.md` 约束原自研 Runtime、Demo、LiteLLM 和 pi 适配实验；`pi/` 以其自身 README 为入口。

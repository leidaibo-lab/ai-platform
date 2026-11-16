# 自研探索实践协作规则

本目录保留 v2 之前的自研 Runtime、Demo、LiteLLM、场景、评测和 pi 适配实验。项目事实以本目录
的代码、`README.md`、`docs/` 和 `openspec/` 为准；如果它们不一致，先检索确认，再做最小范围修正。

## 边界

- 根目录 Mastra 应用是当前主线。本实践的 Runtime、GatewayClient、SQLite Store、天气和图片能力
  不得作为根主线的隐式依赖或能力声明。
- 本实践独立管理 `package.json`、`package-lock.json`、`.env.example`、配置、运行数据和 Demo；
  不读取根主线的真实 `.env`，也不共享运行数据库。
- 旧稳定契约位于本目录 `openspec/`。修改会话、Run、网关、记忆、图片或工具行为时，先更新此处
  的 OpenSpec。

## 协作与安全

- 默认中文协作；提交标题遵循 `type(scope): 中文说明`。
- 不读取、打印或提交真实密钥；环境变量样例只放 `.env.example`。
- 函数使用紧邻职责注释；公共或复杂函数使用 JSDoc；实现遵守 KISS、DRY、YAGNI 和单一职责。
- 不将本实践的构建产物、`node_modules/`、`.data/`、本机日志或数据库作为迁移源码。

## 本地入口

- Runtime 与连接器：`src/`
- 浏览器 Demo：`demo/`
- 回归和场景：`scripts/`、`scenarios/`
- pi 适配实验：`experiments/pi-agent/`
- 专题文档：`docs/`
- 稳定契约与历史 change：`openspec/`

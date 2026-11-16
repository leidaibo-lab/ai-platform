## Why

仓库已确认以 Mastra 为应用主线，但远端最新 `origin/main` 仍将完整应用放在
`practices/mastra/`，根目录则保留自研探索 Runtime。此前未以远端完整基线重构，
会遗漏最新的需求入口、Run 流程状态、执行时间线和团队化 Workflow 代码。

本次以 `fa9715f` 为完整输入重新组织目录：根目录承载 Mastra 应用；自研 Runtime、
Demo、LiteLLM 与 pi 适配实验作为独立探索实践保留。目录变化不得丢失远端现有功能，
也不得让两套运行时、配置或数据目录相互依赖。

## What Changes

- 根 `package.json`、`src/`、`web/`、`config/`、`scripts/`、`tests/`、评测与工作台
  使用 Mastra 应用的完整远端实现，包含 `fa9715f` 的 Run 时间线、SSE 活动流、
  内嵌澄清节点和团队化 Workflow。
- 原根自研实现迁入 `practices/custom-exploration/`，保留其独立依赖锁、环境样例、
  配置、Demo、场景、评测和 OpenSpec。
- 根文档、协作规则和稳定契约改为描述 Mastra 主线；探索文档与局部约束随实践迁移。
- Workflow 执行、审批与恢复继续以 Mastra Store 为唯一事实源；Run 时间线和浏览器活动
  仅是从原生快照与受控事件派生的只读投影。

## Capabilities

### New Capabilities

- `project-mainline`：定义 v2 根目录主线、探索实践隔离、完整远端功能保留和运行数据边界。

### Modified Capabilities

- `ai-platform`：旧自研稳定契约移至 `practices/custom-exploration/`，不再约束根目录主线。

## Impact

- 应用入口、脚本、测试、构建、工作台与文档路径从 `practices/mastra/` 提升至仓库根目录。
- 根依赖切换为 Mastra 锁定依赖；探索依赖保留在独立目录。
- 已有本机 `.data`、`.mastra`、`.env` 与依赖目录不作为源码迁移对象，不读取真实密钥。
- 不推送远端、不部署、不删除历史数据；未提交的此前重构通过 Git stash 保留。

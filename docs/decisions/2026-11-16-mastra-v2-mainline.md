# 以完整远端基线推进 Mastra v2.0 主线

- 日期：2026-11-16
- 状态：接受
- 关联 OpenSpec：[根主线契约](../../openspec/specs/project-mainline/spec.md)

## 背景

远端最新 `origin/main` 已在 `practices/mastra/` 积累完整需求入口、Run 时间线、团队化 Workflow 和工作台代码。此前在未完整同步远端时重构根目录，会遗漏这些能力并造成前端与后端版本不一致。

## 决定

以 `fa9715f` 作为完整远端代码基线，将 Mastra 应用、工作台、配置、脚本、测试、评测和产品 Skill 提升到仓库根目录。原自研 Runtime、Demo、LiteLLM、场景和 pi 适配实验整体下沉到 `practices/custom-exploration/`。

根目录运行以 Mastra Store 保存的 Workflow、审批和恢复事实为准。时间线、SSE、文件归档和业务仓库交接保持只读投影。`practices/mastra/` 不再是主线运行入口。

## 后果

- 主线运行、构建和工作台统一从根 `package.json`、`src/`、`web/` 和 `config/` 进入。
- 根依赖元数据升级为 `ai-platform@2.0.0`；探索实践继续持有自己的依赖与锁文件。
- 历史 ADR 保留当时的验证事实；当前入口统一链接至根目录和 `docs/application/`。
- 可信制品签名校验不阻塞快速测试，后续以独立 OpenSpec 实施可信发布门禁。

## 验证

验证结果以本次迁移后的类型检查、工作台构建、目标测试、OpenSpec 严格校验与隔离 fixture 启动记录为准；历史验证计数不替代本次验收。

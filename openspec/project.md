# AI 应用基础平台 v2.0

## 项目范围

仓库根目录以 Mastra 应用为主线：`src/` 和 `src/mastra/` 承载 Agent、Workflow 与服务，
`web/` 承载工作台，`config/`、`tests/`、`scripts/` 与 `evaluations/` 共同维护运行和验证。
远端完整基线为 `origin/main` 的 `fa9715f`。

原自研 Runtime、Demo、LiteLLM、场景和 pi 适配实验位于
`practices/custom-exploration/`。它是独立探索实践，拥有自己的依赖、配置、数据和 OpenSpec，
不得被主线导入或作为主线能力结论。

## 稳定边界

- Mastra Store 是 Workflow 执行、审批与恢复的唯一事实源。
- 时间线、SSE 活动流、文件归档和业务仓库回执是受控只读投影，不能创建第二事实源。
- 主线必须显式区分 fixture 与 live；测试使用隔离数据目录。
- 可信制品签名校验不作为当前快速测试或普通 live Run 的前提；以
  `MASTRA_ARTIFACT_VALIDATION=enabled` 启用的校验和可信发布门禁保留为后续建设。
- 真实模型调用、费用、远端写入、签名私钥、部署和删除数据都需要明确处理。

## 规范

- `specs/project-mainline/` 定义根 Mastra 主线与探索实践隔离。
- `specs/mastra-role-resources/` 定义需求入口、角色资源、Run 事实和工作台投影。
- `changes/promote-mastra-v2/` 记录本次目录重构。

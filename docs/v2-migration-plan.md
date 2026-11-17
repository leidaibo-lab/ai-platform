# v2.0 Mastra 主线迁移方案

## 基线与目标

本次迁移以远端 `origin/main` 的完整提交 `fa9715f` 为唯一代码基线。该基线已包含需求双入口、团队化 Workflow、Run 时间线、SSE 活动流和最新工作台组件：

- `src/intake/run-timeline.ts`
- `web/src/components/RunFlowMini.tsx`
- `web/src/components/RunActivityFeed.tsx`
- `web/src/components/InlineClarificationNode.tsx`
- `src/mastra/workflows/product-team.ts`
- `src/mastra/workflows/development-team.ts`
- `src/mastra/workflows/product-manager.ts`

目标是让根目录成为完整 Mastra 应用，而不是从旧探索实现中挑选功能拼接。原自研实现完整保留为独立探索实践。

## 目录归属

| 领域 | v2.0 位置 | 说明 |
| --- | --- | --- |
| Mastra 应用与 Workflow | `src/`、`src/mastra/` | 根主线运行入口 |
| 工作台 | `web/` | 需求、澄清、审批、Run 时间线与活动流 |
| 配置、脚本、测试、评测 | `config/`、`scripts/`、`tests/`、`evaluations/` | 使用主线依赖与隔离数据目录 |
| 产品 Skill | `nacos-resources/product/skills/product-pm/` | 产品资源目录下的唯一产品套件，沿用统一 Skill 治理 |
| 运行说明 | `docs/application/` | 根主线操作与边界说明 |
| 自研探索 | `practices/custom-exploration/` | Runtime、Demo、LiteLLM、场景、pi 适配与旧 OpenSpec |

`practices/mastra/` 不再作为运行源码入口。Git 的迁移记录保留原路径到新路径的可追溯性。

## 事实和数据边界

Mastra Store 继续是 Workflow 执行、审批与恢复的唯一事实源。工作台时间线、SSE、文件归档和远端交接仅展示或携带受控投影，不能反向改写 Run 事实。fixture 与 live 使用明确不同的数据目录；本次迁移不读取、不搬迁或删除 `.env`、`.data`、`.mastra` 和本机依赖生成物。

可信制品签名校验不属于本次目录迁移的强制前提。快速测试不要求清单和公钥；将以 `MASTRA_ARTIFACT_VALIDATION=enabled` 启用的校验与可信发布门禁保留在后续独立变更中。

## 回退与验证

取消前的旧 v2 工作树保存在 `stash@{0}`，构建产物和本机依赖备份保留在 `/private/tmp/ai-platform-v2-generated-backup-20261116/`。这些仅作可恢复参考，不作为当前主线重新合并的来源。

迁移验收按以下顺序进行：

1. 根应用类型检查、测试与工作台构建。
2. 根 OpenSpec 严格校验和 Git diff 检查。
3. 确认运行源码不再依赖 `practices/mastra/`。
4. 以隔离 fixture 数据目录启动后端和工作台，检查 Run API 与页面入口。
5. 单独检查 `custom-exploration` 的依赖、文档与局部 OpenSpec，不把其测试当作 Mastra 主线验收。

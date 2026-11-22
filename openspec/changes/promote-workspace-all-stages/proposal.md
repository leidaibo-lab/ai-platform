# 将 Mastra Workspace 推广到完整产研链路

## Why

当前 Workspace 分散用于 Studio 只读资料视图和研发候选执行。产品、测试和发布 Agent/节点仍有直接上下文注入或宿主文件读取，导致资料入口、读取回执和阶段边界不统一。用户要求 Workspace 优先覆盖产品、研发、测试和发布全链路。

## What Changes

- 为产品经理与产品审查 Agent 按 Run 和阶段绑定只读 Workspace，统一读取项目产品资料、固定版本 SDD 和受控交接材料；不扩大资料授权。
- 为测试计划 Agent 绑定同一候选检查点的只读 Workspace，并记录实际读取回执；固定测试执行继续通过受控 Adapter Sandbox。
- 为浏览器 QA 使用候选 Workspace 的显式批准资产视图；保留宿主 Playwright 网络拦截及用例绑定。
- 为发布/交付阶段使用只读 Workspace 核对候选、规格和 QA 证据；仓库写入及 MR 操作仍由宿主固定适配器执行。
- 统一 Workspace 生命周期、Run/阶段/候选绑定、最小工具 allowlist 与证据投影；审批、Workflow 恢复和业务事实仍由 Mastra Store 拥有。

## Capabilities

### Modified Capabilities

- `project-mainline`: 增加产品、研发、测试、发布全链路 Workspace 输入边界、阶段工具权限、来源身份和失败语义。

## Impact

- 影响 `src/mastra/agents/`、产品/测试/交付 Workflow、`src/delivery/`、`src/browser-qa/`、Workspace 工厂、OpenSpec 与 `docs/application/`。
- 新增的 Workspace 只读工具回执进入现有阶段证据，不新增事实库或审批状态。
- 现有 API 和人工审批输入保持兼容；既有 Run 的策略兼容性需要单独验证，缺少新增 Sandbox 身份时不得静默放行。
- 产品、测试或交付缺少已绑定 Workspace/来源时失败关闭；不回退为未经记录的宿主直读。

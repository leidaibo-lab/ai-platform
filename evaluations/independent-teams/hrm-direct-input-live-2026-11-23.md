# HRM 直接需求 live 评测观察（2026-11-23）

案例 `hrm-candidate-follow-up`，研发独立团队 Run `a8bed4ef-64bf-43c3-bbc9-b978ab29040d`，需求散列 `884955e7d33e0988661d9ce9e9c3b70d1abd174a6cda2303860614722889588b`。使用当前未提交代码及隔离 Store，需求为新的候选人跟进待办提案。

运行在 `initialize-team-run` 加载 Nacos 方法目录的 `readTeamMethods → getPrompt` 时收到 HTTP 404，原生 Run 为 failed。日志不足以确认具体缺失的 Prompt 名称或版本。故障位于上游方法资源获取，尚未执行项目范围授权、研发模型调用、方案、实施、检查、评审或交付。建议核对运行配置中团队方法 Prompt 的名称、版本及 Nacos 资源发布状态，再重新执行案例；不要以关闭资源治理替代正式验证。

报告和 Store 保存在 `.data/evaluations/development-team-hrm-candidate-follow-up-482d7965-0dd2-48d9-afca-ca8925ba8d97/`，运行日志 `/tmp/hrm-development-case-live.log`。未调用真实大模型、未执行真实项目检查或远端交付。

## Nacos 修复复验

用户授权后，本机 Nacos 发布并逐项回读核验 `team-product-quality-review`、`team-product-quality-verify`、`team-product-quality-repair` 的 `1.0.0`。新 Run `2bc7a5f2-51ba-4ae7-b0fb-4bdb0003f030` 成功通过资源初始化，暂停于 `confirm-project-scope`。评测启动脚本直接使用 `readConfig()`，没有复用 Studio 的 HRM 仓库装配，评测续跑发现配置无仓库，尚未确认项目范围；该 Run 未调用研发模型。不能通过事后变更绑定冒充已冻结项目。需要修正评测启动配置并新建 Run，再验证研发流程。

## 已绑定 HRM 的真实模型复验

修正评测脚本的 Studio 工程配置装配后，新 Run `b351512a-6f94-45d0-9f69-a986c24d8deb` 冻结 HRM 项目，经过评测范围确认，实际调用模型并完成 `prepare-context`。`architecture` 首次方案因 `path-unauthorized` 输出校验失败，第二次记录 `model-error`（来源 unknown），最终业务结果 `manual-attention`；原生外层 success 不表示研发交付。方案授权、实施、检查、评审和交付均未完成。具体越权路径和第二次模型错误原因未记录，需补足脱敏诊断并核对项目授权目录和模型方案。运行档案提示保存或同步未完成，尚未查明原因。

原生 Store 为 `.data/evaluations/development-team-hrm-candidate-follow-up-7ecfdc7e-a203-4d13-869c-38fb99f2044a/workflow.db`；日志 `/tmp/hrm-direct-live-bound-resume.log`。未执行远端交付。

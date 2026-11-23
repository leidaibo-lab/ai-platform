# HRM 直接需求 live 评测观察（2026-11-23）

案例 `hrm-candidate-follow-up`，研发独立团队 Run `a8bed4ef-64bf-43c3-bbc9-b978ab29040d`，需求散列 `884955e7d33e0988661d9ce9e9c3b70d1abd174a6cda2303860614722889588b`。使用当前未提交代码及隔离 Store，需求为新的候选人跟进待办提案。

运行在 `initialize-team-run` 加载 Nacos 方法目录的 `readTeamMethods → getPrompt` 时收到 HTTP 404，原生 Run 为 failed。日志不足以确认具体缺失的 Prompt 名称或版本。故障位于上游方法资源获取，尚未执行项目范围授权、研发模型调用、方案、实施、检查、评审或交付。建议核对运行配置中团队方法 Prompt 的名称、版本及 Nacos 资源发布状态，再重新执行案例；不要以关闭资源治理替代正式验证。

报告和 Store 保存在 `.data/evaluations/development-team-hrm-candidate-follow-up-482d7965-0dd2-48d9-afca-ca8925ba8d97/`，运行日志 `/tmp/hrm-development-case-live.log`。未调用真实大模型、未执行真实项目检查或远端交付。

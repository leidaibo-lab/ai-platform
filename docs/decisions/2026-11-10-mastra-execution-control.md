# 适配 Mastra 运行诊断与只读生成取消

- 状态：接受
- 日期：2026-11-10
- 负责人：Mastra 实践维护者
- 范围：独立实践渠道与产品生成；不改变探索主线 OpenSpec 契约

## 问题与约束

长 HTTP 请求不能反映后台尝试和重试，断线也不等于取消。必须传播实际 AbortSignal，拒绝取消后迟到正文，保留原生 Store 终态和已有恢复校验。不得把开发、Git 推送、发布等有副作用阶段宣称可安全取消。

## 候选与证据

| 候选 | 路线 | 结论 |
| --- | --- | --- |
| Mastra Studio 原生 cancel | 一体化 | 原生 Run.cancel 可落 canceled，但缺少本业务尝试明细与实际退出确认 |
| 原生 cancel + AbortSignal + 进程内诊断投影 | 轻量组合 | 适配；复用当前 core 1.81.0 createRun 活动实例缓存、cancel、步骤 abortSignal 和 Agent 信号 |
| 自建持久取消状态机 | 自研 | 不采用，复制原生事实和恢复系统，维护成本高 |

源码证据：@mastra/core/dist/agent-DtdQ6un6.js 的 createRun、Run.cancel；workflows/step.d.ts 的 abortSignal；Agent generate/stream 的 abortSignal。原生 cancel 先落终态，不等待步骤退出，因此页面必须独立显示取消中直到本地调用 finally 退出。

## 决策与实施边界

结论：适配。新增 execution-control Adapter，运行 token 绑定一次产品生成调用，只有本进程活动只读生成可取消；先同步登记取消意图以阻断迟到交付，再调用原生 cancel，并在 finally 中止本地控制器，避免跨阶段误取消。角色完成前检查信号，不放行迟到结果。诊断是有界易失投影，不作为审批、恢复或终态事实库；历史缺失明确说明。原生 Store 拥有终态；不支持跨进程取消和旧服务进程活动控制。参数只读，不热改。

核心数据：runId、随机 token、role、startedAt、lastActivityAt、attempt、attemptStartedAt、phase、脱敏 ProductAttempt[]、settled。进程内单写者，最多保留200条最近投影。信号与取消标记不公开。前端写请求期间持续独立 GET。

受影响路径：src/intake/{execution-control,product-generation,workflow,routes,service}.ts、src/mastra/workflows/product.ts、web/src/{IntakeApp,ExecutionStatus}.tsx、测试及使用说明。不新增依赖和配置，不迁移原生快照。使用 Adapter；不引入第二调度器。

## 验收与风险

验证：类型检查、产品生成与原生嵌套取消回归、前端构建，覆盖重试等待、迟到结果、旧 token、并发取消和完成竞争。真实模型取消费用与上游是否立即停止计算无法由本地证明；页面只确认本地执行停止。重启丢失细粒度观察，不伪造历史。维护责任属于 Mastra 实践。升级 core、启用多实例或扩展副作用阶段时重评；退出时删除诊断投影，不影响原生快照。

2026-11-10 验证记录：类型检查与前端构建通过；26项定向回归通过；本机交付及问题分类独立重跑8项通过。真实浏览器合成API验证长写请求期间轮询、524重试详情、只读配置、取消二次确认、取消中与退出分离及刷新回读，1次取消请求。全量288项中曾出现2项失败（精简Agent默认回调兼容已修复；并行本机浏览器用例blocked，独立重跑通过），不宣称全量一次全绿。浏览器复跑入口：practices/mastra/scripts/verify-execution-ui.mjs。

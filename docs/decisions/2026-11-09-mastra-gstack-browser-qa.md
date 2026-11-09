# 适配 gstack 方法并接入 Mastra 浏览器 QA

- 状态：接受（2026-11-09 用户确认沿用 Mastra/BMAD 并优先浏览器 QA；工程与真实模型质量分别验收）
- 日期：2026-11-09
- 负责人：Mastra 实践维护者
- 所属区域：practices/mastra 独立实践及根通用 Skill
- 关联需求：增强 Workflow 内运行的 Agent，注册方法、工具、输入输出契约与执行节点。
- 关联 OpenSpec：探索主线契约不变；本实践新增测试方法及可选证据字段，先在 browser-qa.md 固化本地版本契约。旧用例与旧记录不增加缺省证据。
- 替代记录：无；细化现有完整产研生命周期与 BMAD 方法适配。

## 问题

测试 Agent 当前只生成计划；宿主执行登记套件，人工补充浏览器结果。缺少对同版本候选页面的真实操作、断言与截图证据。方法名称或角色数量不能证明质量提升。

## 约束与非目标

保留 Mastra Store、原生 Workflow、BMAD 评审、批准与返工，不引入第二套调度或审批。QA 不写源码、不批准、不执行 shell。首版只支持批准快照内静态 HTML 及显式资产；HRM 动态服务缺少版本绑定的启动 Adapter，必须标记 blocked。首版不导入全部 gstack、Aside、个人浏览器会话、遥测、自动升级、发布脚本或安全扫描器。

## 候选方案

| 候选 | 路线 | 优势 | 缺口与证据 |
| --- | --- | --- | --- |
| 整体 gstack 宿主工具链 | 成熟一体化 | 完整专项方法与浏览器辅助 | review 含自动修复、宿主脚本与状态约定；browse 优先个人 Aside 会话，与现有只读评审和原生 Store 不同。已读固定 commit 源码与 README |
| 精选 gstack 方法 + Playwright + 原生 Mastra | 轻量组合，选择 | 方法与执行分离，受限工具可绑定源码与批准用例 | 本地维护 schema、静态目标服务与证据 Adapter；Playwright npm 实际版本为1.65.0，浏览器运行需单独安装 |
| 现有方法 + 自写浏览器/CDP 驱动 | 最小自研 | 无方法导入成本 | 重复实现浏览器兼容、定位和等待；无证据优于成熟 Playwright，因此不选 |

## 淘汰条件

未绑定候选版本、访问任意 URL/真实登录会话、模型自报通过、缺失浏览器时跳过为通过、覆写旧质量证据、执行上游脚本或自动放宽审批，均不接受。

## 关键验证

验证原生 Agent 实际 skill/skill_read/浏览器工具调用；真实 Chromium 表单交互与截图；错误断言、外部网络、版本漂移、未执行工具、缺失浏览器与不支持目标不得通过；原生暂停重装 Store 后保留证据；旧流程回归。实际结果在完成报告追加。

## 决策

结论：适配。gstack 固定 commit b6155921a564ba9ec2470fd2cb3894c05e2c2d13，已通过 GitHub commit API 核对。只选 qa-only 的证据报告方法和 qa 的浏览器模式参考，原文、MIT 和 SHA256 随 Skill 保存。Playwright 精确锁定1.65.0；不执行 gstack setup。

平台拥有 BrowserCase/BrowserReceipt、候选静态服务、角色工具注册、预算、结果绑定和质量门；Playwright 拥有浏览器驱动；gstack 提供专业方法，Mastra 拥有执行循环与持久化。

## 未采用方案及原因

全量 gstack 会重复现有流程、增加宿主状态与权限适配；自写驱动没有收益证据。若 gstack 提供稳定独立执行接口、或全栈/远程隔离需要变化，再评估目标 Adapter。

## 实施边界与计划

- 路径：根 testing/gstack-browser-qa Skill、Mastra browser-qa 模块、delivery/contracts.ts 与 testing.ts、测试与操作文档。
- 数据：BrowserCase 为批准输入；BrowserReceipt 为工具实际回执，含源码/用例/方法散列、步骤、状态、截图及其散列；QA 叙述不决定机器结果。旧用例无 browser 字段；未执行没有通过回执。
- 模式：原生 Agent 工厂、Playwright Adapter、已有 Workflow 顺序和质量门；不新建通用调度器或浏览器驱动。
- 执行：每用例独立内存静态服务和无凭据浏览器上下文，显式文件白名单，仅自身 origin、GET/HEAD；禁外部请求、WebSocket、下载、弹窗与 Service Worker；总时限、操作次数和证据体积有界。
- 兼容：旧 registered-check/manual 保持行为；新增 browser 用例显式批准后执行。旧 qualityHash 无可选字段时维持原值。HRM 不伪装静态目标。
- 不给开发评审自动修复能力；首版只引入 QA 方法，不扩展产品/发布角色。

## 验收计划

- [x] 类型检查、Skill 治理、OpenSpec strict。
- [x] 真实浏览器成功/失败、外联阻断、版本与证据校验。
- [x] 原生 Agent 工具链、Workflow 节点、质量门与恢复回归。
- [ ] 真实模型质量与现有方法对照（独立后续验收，不冒充工程测试）。

## 风险与退出路径

浏览器存在资源和平台依赖，截图可能含测试数据，限隔离合成数据；测试 Agent 会误解观察，因此放行依赖工具回执与人工质量门。维护者负责固定方法升级差异、许可和浏览器版本回归。停用新 browser 用例即可退出，新旧 Run 保留原证据，不将已批准浏览器测试降级人工通过。

## 验收与完成报告

2026-11-09 本地实际验证（Node 24.19.0）：

- Mastra 全量 `npm test`：237项通过，0失败/跳过，包含真实 Chromium 表单输入、点击、截图、错误断言、外联阻断、浏览器缺失故障注入、方法/源码漂移、截图损坏、缺证据与人工覆盖拒绝。
- 原生 QA Agent 的 skill、skill_read、runBrowserCase 实际执行；Workflow browser-success/browser-failure 均逐暂停点关闭并重装 Store，分别完成成功主链和失败阻塞。
- 后端类型检查、前端类型检查与 Vite 构建通过；前端保留 chunk 体积提示。Skill 治理输出 SKILL_STRUCTURE_OK，OpenSpec strict 为1项通过。
- 原目录存在正在运行的 mastra dev，CLI 保护性拒绝 build；未停止或覆盖服务。在仅复制源码、配置、方法与依赖入口的临时副本中执行 Mastra build 成功（未复制 .env）。
- 关键入口：[QA Agent](../../practices/mastra/src/browser-qa/agent.ts)、[Playwright Adapter](../../practices/mastra/src/browser-qa/runner.ts)、[用例/回执](../../practices/mastra/src/browser-qa/contracts.ts)、[质量门](../../practices/mastra/src/delivery/testing.ts)、[使用与本地契约](../../practices/mastra/browser-qa.md)。

自研仅限批准输入与工具回执的数据绑定、静态快照服务和现有质量门接线；采用原生 Agent 工厂与 Playwright Adapter 模式，方法不拥有权限、模型不拥有执行结果，遵守单一职责与最小范围组合。新增函数与回调均有紧邻职责注释，外部 I/O 与输入 schema、证据校验分层。

首版不承诺 HRM 全栈浏览器、真实模型净收益或生产浏览器隔离。下一次全栈目标、浏览器隔离或上游方法升级触发重评；真实模型与原方法的质量对照仍是独立未完成验收。

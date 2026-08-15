## 1. 方案与契约

- [x] 1.1 建立接受状态方案决策，对比显式三选一、前端启发式和 Runtime 结构化分类
- [x] 1.2 固化附件候选矩阵、`0.85` 阈值、真实 operation 和默认模型边界
- [x] 1.3 增加 stable 与 delta OpenSpec

## 2. Runtime 路由

- [x] 2.1 使用 AI SDK `Output.object` 实现受候选 enum 限制的 `{ operation, confidence }` 分类
- [x] 2.2 实现附件硬约束、低置信度和非取消分类失败的对话回退
- [x] 2.3 让分类继承调用方取消信号和最多 10 秒的子截止时间；分类前中止请求时不创建 Run 或继续业务模型
- [x] 2.4 在业务调用前持久化真实 operation，不保存 provider 原始分类文本
- [x] 2.5 让相同 requestId、显式继续编辑和恢复动作绕过分类
- [x] 2.6 拒绝 auto 请求中的浏览器模型，并按真实 operation 读取服务端默认别名

## 3. 渠道与验证

- [x] 3.1 把普通发送默认切为智能模式，保留历史图片继续编辑与恢复入口
- [x] 3.2 覆盖附件矩阵、`0.8499/0.85`、非法结构、分类失败和候选越权回归
- [x] 3.3 覆盖真实 operation 持久化、幂等重放和 auto 模型注入拒绝
- [x] 3.4 移除普通输入区的模式与模型选择控件，默认只提交 `operation=auto`；保留历史图片继续编辑与 Run 恢复显式入口
- [x] 3.5 增加分类阶段请求中止/子截止时间，以及 `retry / regenerate / continue` 继承 operation 且不调用分类器的直接回归
- [x] 3.6 运行首版路由定向测试、完整非 HTTP 测试、HTTP/SSE 测试、Demo 构建/预算和 `git diff --check`

## 4. 会话上下文感知路由

- [x] 4.1 新增 2026-08-15 替代决策，并同步 stable/delta OpenSpec、change design 和场景链边界
- [x] 4.2 从 Message、真实 Run operation 和可用 `image_asset` 派生活动图片，实现带版本、消息数量与单条正文字符上限的 routing snapshot
- [x] 4.3 把分类 schema 收窄为 `operation / confidence / useActiveImage / relevantMessageIds`，禁止模型返回 assetId、模型、参数或自由 Prompt
- [x] 4.4 实现当前附件优先、活动图片三候选、历史证据校验、视觉聊天按需继承和非法证据安全回退
- [x] 4.5 由 Runtime 从不可变消息组装隐式编辑 Prompt，选择并再次校验实际源资产，不依赖前端附件缓存
- [x] 4.6 在 Run/Message 一致提交边界内保存真实 operation、实际图片引用和版本化脱敏 intentDecision
- [x] 4.7 处理分类期间的会话版本变化：首次 `routing_context_stale` 重路由，第二次返回 `routing_context_changed`，不得使用过期源图执行
- [x] 4.8 向会话读取投影服务端活动图片，刷新和普通聊天轮后 Composer 只做展示，不成为路由事实源

## 5. 分层评测与验收

- [x] 5.1 增加 `scenarios/runtime-routing/` 版本化 schema、首个 case/model-fixture/gold 和独立契约校验，场景输入与标准答案不进入业务实现
- [x] 5.2 用直接确定性回归覆盖 A→B→视觉核查→无附件续改→C、非法证据、活动图片继承、intentDecision、快照冲突重路由、刷新投影与幂等重放
- [x] 5.3 实现消费 `scenarios/runtime-routing/` 的通用双模式 Runner，并让确定性模式使用脚本分类器和 fake 图片 Gateway
- [ ] 5.4 扩充无关聊天、新图生成、显式旧图覆盖、低置信度、跨会话资产等完整版本化 fixture 矩阵
- [x] 5.5 真实模型模式固定模型别名、实际模型、Prompt/schema、采样参数和 fixture 版本，图片执行保持 fake，并报告 operation/源资产/活动图片/证据指标、token、平均延迟与 P95
- [x] 5.6 在配置可用时运行真实模型识别 smoke；样本少于 30 只报告 `observation-only`，不得写成发布准确率
- [x] 5.7 使用固定版本 OpenSpec CLI 执行 `openspec validate add-smart-operation-routing --strict` 和 `openspec validate --specs --strict`
- [x] 5.8 加固 `routing-context.v2` 投影：排除 interrupted 消息、脱敏历史 URL，并校验助手活动图片的 completed Run 与会话资产事实链
- [x] 5.9 让图片调用前重读源图，收敛实际 Prompt 证据，并让 Runner 直接观测视觉输入、编辑源字节、Prompt 和失败图片副作用
- [x] 5.10 补齐 `conversationId + requestId` 分类期显式取消入口，验证无 Run/消息、无业务模型调用，并保留 SSE 断线继续执行语义

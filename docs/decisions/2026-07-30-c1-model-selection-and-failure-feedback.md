# C1 会话模型选择与失败反馈

- 状态：接受
- 日期：2026-07-30
- 负责人：AI 应用基础平台维护者
- 所属区域：渠道与体验层 / Agent Runtime / 模型网关
- 关联需求：用户需要在会话输入区选择网关已开放的模型，并在生成失败时直接看到安全、可执行的原因反馈
- 关联 OpenSpec：`openspec/specs/ai-platform/spec.md`
- 替代记录：无；补充 `2026-07-29-c1-channel-experience-ant-design-x.md`

## 问题

当前页面只在侧栏展示固定的 `chat-default`，Run 请求无法表达用户选择的模型。模型调用失败后，Runtime 已持久化错误分类与状态码，但渠道层主动丢弃这些事实，只显示“本次生成失败”，用户无法区分鉴权、限流、超时、模型不可用和服务故障。

本次目标是让用户在 Sender 内选择 LiteLLM 当前授权可见的模型别名，并把失败 Run 的安全分类转为紧邻用户消息的原因和处理建议。成功证据是：模型选项来自网关事实、所选别名进入同一个 Runtime/GatewayClient 主链、失败原因不依赖打开运行信息、且浏览器不获得真实上游模型配置、密钥或 provider 原始错误正文。

## 约束与非目标

### 必须满足

- 浏览器只提交 LiteLLM 模型别名，所有模型调用继续经过 Agent Runtime 和 GatewayClient。
- 模型选项来自当前 LiteLLM key 可见的 `/v1/models`，不得在前端维护第二份固定列表。
- 未传模型的既有客户端继续使用 `LITELLM_MODEL` 默认别名。
- 失败反馈只能使用平台拥有的错误分类、公开状态和安全文案，不展示 provider 原始响应、stack 或密钥。
- Run 选中的别名必须进入 token counter、模型生成和失败事实，不能只改变 UI 标签。

### 本次不解决

- 不向普通用户展示 `config.yaml` 中真实上游模型名、供应商账户或成本策略。
- 不实现模型收藏、最近使用、按用户授权或控制面发布策略。
- 不将模型选择固化为会话级服务端配置；当前选择作用于单次 Run，并由渠道草稿按会话保留。
- 不新增真实生成健康探测，避免仅为状态展示产生模型调用费用。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| AI Elements Model Selector + AI SDK UI | 成熟一体化 | 模型选择组件及 AI SDK UI 消息交互 | 模型选择交互完整，生态组件可组合 | 会引入第二套 UI 数据协议，不能直接复用当前 Ant Design X Sender 和自有 POST SSE Adapter | `docs/decisions/2026-07-29-c1-channel-experience-ant-design-x.md` 的既有候选结论 |
| LiteLLM `/v1/models` + Ant Design `Select` + 现有 Runtime Adapter | 轻量可组合 | 模型目录、受控选择、Run 别名透传和安全失败映射 | 复用现有网关授权结果与 UI 体系，不改变会话事实源和 SSE 主链 | 需要扩展稳定 Run 输入并保证每层使用同一别名 | `src/gateway/litellm-management-client.mjs`、`demo/src/runtime-adapter.js`、已锁定 `antd@6.5.2` |
| 前端硬编码模型列表和通用失败文案 | 最小自研 | 本地 Select 与字符串映射 | 改动最小，无额外网关读取 | 列表会与 LiteLLM 配置和权限漂移；仍无法形成可信失败原因 | 当前固定 `LITELLM_MODEL` 与“本次生成失败”实现 |

## 淘汰条件

- 让浏览器绕过 Runtime 直连 LiteLLM 或上游 provider。
- 以真实上游模型配置代替稳定别名，或把密钥、原始错误正文带到渠道。
- 模型选择只存在于 React 状态，没有进入 Runtime、token counter、GatewayClient 和 Run 事实。
- 为增加一个选择器而替换现有 Ant Design X、POST SSE 或 SQLite 事实源。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| `/v1/models` 可提供当前 key 可见的模型别名 | 扩展 GatewayClient 管理端点协议测试 | LiteLLM OpenAI-compatible models 响应 | 通过；状态返回去重别名，未知非默认别名返回稳定 400 | `scripts/test-gateway-client.mjs` |
| 单次 Run 可在不新增业务入口时选择模型 | 从 Demo Adapter 提交 `model`，断言 token counter 与 chat completions 使用同一别名 | 当前 Runtime/GatewayClient Port | 通过；选择别名进入规划、生成和完成 Run 事实 | `scripts/test-runtime.mjs`、`scripts/test-demo-adapter.mjs` |
| 失败分类足以形成可执行反馈且不泄露原始错误 | 构造 401、429、504、503 和未知错误的视图模型测试 | 当前 resilience attempts | 通过；渠道只显示平台标题、原因和建议 | `scripts/test-runtime.mjs`、`scripts/test-demo-adapter.mjs` |
| Sender 内选择器和失败卡在桌面、移动端不挤压输入 | 浏览器验证可见性、选择、发送、失败反馈和控制台 | 1280x720、390x844 | 通过；模型下拉可展开，401 显示“模型鉴权失败”及处理建议，移动端无横向溢出且控制台无错误 | `demo/src/App.jsx`、`demo/src/styles.css` |

## 决策

- 结论：适配。
- 选择方案：LiteLLM `/v1/models` + Ant Design `Select` + 现有 Runtime Adapter。
- 决策依据：LiteLLM 已拥有模型目录与 key 可见性，Ant Design 已提供成熟选择控件；平台只需拥有模型别名的稳定 Run 契约和错误分类到渠道反馈的映射。
- 平台拥有：Run 模型字段、默认模型兼容、GatewayClient Port、错误分类、安全反馈文案和验收测试。
- 外部方案负责：LiteLLM 模型目录与别名路由，Ant Design 选择控件与可访问性交互。
- 明确不实现：第二套模型目录、浏览器直连模型、provider 原始错误展示和会话级模型策略控制面。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| AI Elements Model Selector + AI SDK UI | 当前渠道已接受 Ant Design X，单独引入另一套交互体系不能减少 Runtime 或 Adapter 复杂度 | 多个 Web 渠道统一迁移到 AI SDK UI 协议，且能保留现有事实源和错误边界 |
| 前端硬编码列表 | 无法表达 LiteLLM 动态配置和 key 权限，配置漂移会产生不可发送的选项 | 模型集合长期固定且由构建版本而非网关控制 |
| 展示 provider 原始错误 | 可能包含上游地址、账户信息、请求正文或敏感配置，不满足渠道安全边界 | 无；原始错误只允许进入受控服务端诊断面 |

## 实施边界

- `GET /api/gateway/status` 增加 `models`，仍只表示 `/v1/models` 可达和当前 key 可见别名，不代表生成可用。
- Run 的 `model` 可选；缺失时回退 `LITELLM_MODEL`，非默认别名必须存在于网关可见模型集合。
- Context Planner token counter 与 GatewayClient generation 使用同一个已解析别名；Memory Manager 后台任务继续使用默认模型。
- 失败 Run 持久化安全摘要和既有 resilience 分类；渠道按分类生成标题、原因与处理建议，并继续提供恢复输入和运行信息。
- 渠道草稿按 conversationId 保留模型选择；服务端不把它升级为会话配置或控制面策略。

## 风险与退出路径

- 已知风险：模型目录会在网关配置变化后短暂过期；通过状态刷新和非默认别名按需重新读取控制风险。
- 锁定点：OpenAI-compatible `/v1/models` 响应中的 `data[].id`、Run `model` 字段和现有 resilience 分类。
- 退出路径：Select 可替换而不迁移会话数据；模型目录可改由未来控制面发布，但继续保持 GatewayClient alias Port。
- 维护责任：渠道层维护选择器和反馈文案，Runtime 维护 Run 模型与安全错误边界，模型网关维护别名和访问权限。

## 验收与完成报告

- 验证证据：`npm test` 55/55 通过，`npm run demo:build` 通过，`openspec validate --specs --strict` 1/1 通过；桌面端和 390x844 移动端浏览器验收通过。
- 剩余边界：当前只有 `chat-default` 时选择器仍会显示单一选项；更多模型需要先在 LiteLLM 配置和权限中开放。
- 文档与契约：同步 `README.md`、本记录和 `openspec/specs/ai-platform/spec.md`。
- 重评条件：模型选择需要按租户/用户授权、出现成本或数据驻留策略、模型数量导致检索与分组需求，或未来控制面开始发布版本化模型策略。

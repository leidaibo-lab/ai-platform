# C2 图生图采用 AI SDK 图片编辑路径

- 状态：已替代
- 日期：2026-07-31
- 负责人：AI 应用基础平台维护者
- 所属区域：Agent Runtime
- 关联需求：为 C2 增加可实际使用的图生图能力
- 关联 OpenSpec：`openspec/changes/add-c2-image-editing/`
- 替代记录：`docs/decisions/2026-08-02-c2-multi-turn-image-editing-responses-path.md`；本记录保留 `/images/edits` 的历史验证证据

## 问题

当前 `image.generate` 只能根据文本创建新图片，Runtime 明确拒绝图片输入。目标用户需要把一张已有图片与编辑指令交给同一 C2 能力域，获得新的受控图片资产，同时继续使用 Conversation、Run、幂等、取消、模型别名、资产权限和 SSE 交付。

成功证据是：浏览器能先建立受控源资产，再提交显式 `image.edit`；GatewayClient 经 LiteLLM `/images/edits` 发送 multipart；编辑结果形成新的 `image_asset`；相同 requestId 不重复调用模型；跨会话资产在模型调用前被拒绝。

## 约束与非目标

### 必须满足

- 所有图片编辑请求统一经过 Agent Runtime、GatewayClient 和 LiteLLM，不得浏览器直连 provider。
- 源图必须是当前会话拥有的稳定 `image_asset`，Run JSON 不保存图片二进制、data URL 或物理地址。
- 源资产不可变；编辑输出创建新资产并保留源引用。
- 没有端到端 provider 幂等证据时固定单次模型尝试，并在 LiteLLM 图片别名配置 `num_retries: 0`。
- 图片、完整提示词、multipart 正文和 provider 响应不得进入普通日志或 Trace。

### 本次不解决

- 遮罩、局部重绘、多图融合、远程 URL 导入、风格训练和批量任务。
- 正式对象存储、恶意文件扫描、内容审核、成本基线和生产可用声明。
- 独立图片编辑服务或人工精修工作台。

## 候选方案

| 候选 | 路线 | 覆盖范围 | 关键优势 | 关键缺口或风险 | 证据 |
| --- | --- | --- | --- | --- | --- |
| AI SDK `generateImage` 编辑 Prompt + openai-compatible + LiteLLM | 轻量可组合 | Runtime 到模型网关的图片编辑协议 | 锁定依赖已支持 `{ text, images }`，自动使用 `/images/edits` multipart；复用现有 Port、别名、错误和取消 | LiteLLM/真实上游兼容仍需 smoke，通用选项有限 | `node_modules/ai/src/generate-image/generate-image.ts`、`node_modules/@ai-sdk/openai-compatible/src/image/openai-compatible-image-model.ts` |
| GatewayClient 自行构造 `/images/edits` multipart | 最小自研 | 仅图片编辑 HTTP Adapter | 可精确控制 multipart 和 provider 差异 | 重复 AI SDK 已实现的文件归一化、错误、取消和返回解析，维护成本更高 | OpenAI-compatible Images API 与现有 GatewayClient fallback 边界 |
| provider SDK 或专用图片工作流服务直连 | 成熟一体化 | 图片生成、编辑乃至工作流 | 可能提供更完整编辑参数、队列和工作流 | 形成 LiteLLM 之外的模型访问链，扩大 key、部署和运维边界；当前单图需求不需要 | 现有六区架构与模型访问单向依赖约束 |

## 淘汰条件

- 绕过 Runtime 或 LiteLLM，向浏览器暴露 provider key、真实模型 ID 或上游地址。
- 需要把图片二进制、data URL、临时 provider URL 或 storageKey 写入稳定 Run/Message。
- 无法传播取消和截止时间，或可能在不确定失败后自动重复编辑并计费。
- 破坏源资产不可变性或无法校验 Conversation 所有权。

## 关键验证

| 假设 | 验证方法 | 输入与版本 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| AI SDK 能表达单图编辑 | 检查锁定源码和类型，确认 Prompt 归一化为 files | `ai@7.0.37`，Buffer 源图 | 通过 | `node_modules/ai/src/generate-image/generate-image.ts` |
| openai-compatible 会切换编辑端点 | 检查锁定 Adapter 源码与官方包内文档 | `@ai-sdk/openai-compatible@3.0.14` | 通过；存在 files 时使用 `/images/edits` 和 FormData | `node_modules/@ai-sdk/openai-compatible/src/image/openai-compatible-image-model.ts` |
| 当前平台边界可复用 | 对既有生成 Run、ImageAssetStore、SQLite 和 SSE 做变更面审计 | 当前 `c6e068c` | 通过；只需增加上传资产、编辑操作和 Port 方法 | `src/runtime/chat-runtime.mjs`、`src/storage/conversation-store.mjs` |
| LiteLLM 与真实上游完整兼容 | fake multipart 协议测试后执行三次真实单模型 smoke | `gpt-image-2` 平台别名、1024x1024 合成 PNG | 协议链可达；三次均被上游以无可用兼容账号拒绝，真实 happy path 未通过 | `scripts/test-gateway-client.mjs`、`scripts/test-image-generation.mjs`、本地 Run 韧性事实 |
| 图片副作用保持单次尝试 | 对比网关配置修正前后的 Runtime 与 LiteLLM 日志 | 三个独立 requestId | Runtime 三次均为 1 次；首次暴露 LiteLLM 内部重试 2 次，配置 `num_retries: 0` 后两次不再重试 | `config.yaml`、`scripts/test-architecture-boundaries.mjs`、本地 LiteLLM 日志 |

## 决策

- 结论：适配
- 选择方案：复用 `ai@7.0.37` 图片编辑 Prompt 与 `@ai-sdk/openai-compatible@3.0.14` `/images/edits` Adapter，通过既有 LiteLLM 图片别名调用。
- 决策依据：锁定依赖已经拥有核心协议、文件归一化、取消和响应映射；平台只需拥有业务操作、资产权限、幂等、治理和交付，避免重复实现 multipart 客户端。
- 平台拥有：`image.edit` Run 契约、受控上传、`image_asset` 元数据与所有权、源引用、参数白名单、幂等、取消、错误、交付和评测。
- 外部方案负责：图片模型执行、OpenAI-compatible multipart 编码、provider 路由和真实模型凭据。
- 明确不实现：图片算法、通用工作流引擎、对象存储协议、恶意文件扫描引擎、审核模型和 provider 专属 SDK 直连。

## 未采用方案及原因

| 未采用方案 | 原因 | 哪些变化会触发重新评估 |
| --- | --- | --- |
| 自研 multipart Adapter | 与锁定 AI SDK Adapter 重复，当前没有证据表明其协议不可用 | LiteLLM 或目标 provider 与 AI SDK Adapter 出现不可兼容差异且无法通过 providerOptions 修复 |
| provider SDK/专用服务直连 | 破坏统一模型访问和 key 边界，当前单图编辑不值得新增部署面 | 图片工作流、队列、局部重绘或专用 GPU 调度成为核心需求，且可继续通过 Runtime Port 隔离 |

## 实施边界

渠道先向会话资产入口上传本地图片；Runtime 校验并登记资产后，`image.edit` 只接收 assetId。Runtime 解析 storageKey 并读取字节，GatewayClient 只接收规范化 Buffer，不接收任意 URL。GatewayClient 复用同一图片模型别名和单次尝试策略。编辑结果先写 ImageAssetStore，再在 SQLite 事务中完成 Run、Message 和资产引用；失败清理未提交输出，不删除源资产。

## 风险与退出路径

- 已知风险：当前上游账号池没有图片编辑兼容账号，真实 happy path 未通过；内容审核、成本、完整解码和孤立上传清理也尚未验收，对外保持开发切片表述。
- 重评状态：已触发“真实模型编辑端点失败”条件。当前保留 `editImages` Port、受控资产契约和 AI SDK Adapter，不新增 provider 直连；待取得兼容账号或上游给出替代兼容路径后，用同一合成 fixture 重新比较 Adapter 兼容性、成本和结果质量。
- 锁定点：AI SDK ImageModelV4 Prompt、OpenAI-compatible `/images/edits` multipart、LiteLLM 图片别名和 `image_asset` 元数据。
- 退出路径：GatewayClient Port 保持 `editImages` 不变；若 Adapter 不兼容，可在 Port 内替换为专用 HTTP Adapter。回滚时关闭上传 POST 与 `image.edit`，已有资产只读保留。
- 维护责任：AI 应用基础平台 Runtime 与 GatewayClient 维护者负责契约、资产治理和兼容回归；模型网关维护者负责 LiteLLM 路由与凭据。

## 验收与完成报告

- 验证证据：锁定依赖源码审计；Gateway multipart、Runtime 幂等/权限、HTTP 上传和 Demo Adapter 回归；三次真实请求验证编辑端点可达和 provider 不可用错误收口。
- 剩余边界：取得编辑兼容账号后的真实 happy path、内容审核、成本、多图、遮罩、正式 MediaGuard 和资产保留期。
- 文档与契约：同步 OpenSpec change、README、场景链、AI SDK 对齐和决策索引。
- 重评条件：真实模型编辑端点失败、需多图/遮罩、上传规模超过本地 Adapter、正式租户鉴权或内容安全进入生产门禁。

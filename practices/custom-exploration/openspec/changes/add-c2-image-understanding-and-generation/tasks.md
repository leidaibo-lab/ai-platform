## 1. 方案验证与参数收敛

- [ ] 1.1 用锁定的 AI SDK、openai-compatible 和 LiteLLM 版本完成单一真实图片模型 PoC，记录文生图请求、返回格式、usage、取消、超时和错误证据
  - 2026-07-31 已完成真实 happy-path：单次尝试约 41.7 秒，返回 1 张有效 PNG；usage 只有生成张数。真实取消、超时和错误证据未齐，任务保持未完成。
- [ ] 1.2 对比 S3-compatible 对象存储、本地受控文件存储和 SQLite BLOB，确认首个 ImageAssetStore、保留期、清理责任和退出路径
- [ ] 1.3 对比 provider 原生审核、独立审核服务和组合策略，确认输入提示词、理解图片和生成结果的审核门禁
- [ ] 1.4 在方案决策中补齐真实 PoC 结果、模型与参数白名单、未采用原因，并在验证通过前阻止对外宣称真实模型可用

## 2. 图片资产与媒体治理

- [x] 2.1 为 `image_asset` 元数据和 Message/Run 产物引用增加 SQLite 迁移、JSDoc 数据结构与 Store 回归测试
- [x] 2.2 实现 ImageAssetStore Port 和选定 Adapter，保证物理地址不进入稳定消息、普通日志或 Trace
- [ ] 2.3 实现 MediaGuard 的真实 MIME、解码、大小、数量、尺寸和允许格式校验，并覆盖异常与资源上限测试
- [ ] 2.4 增加 Conversation 范围的图片资产上传、读取和生命周期入口，验证越权、过期、缺失和失败清理
- [ ] 2.5 扩展分类型引用解析以支持 `image_asset`，保持 `conversation_message` 和现有 `imageUrls` 兼容

## 3. 模型能力与 GatewayClient

- [ ] 3.1 建立平台模型能力目录，声明 `image-input`、`image-output`、格式、数量、尺寸和宽高比限制
- [x] 3.2 扩展 GatewayClient Contract 与 Adapter，增加经 LiteLLM 调用的图片模型路径，并保持 Runtime 不感知 provider key 和真实模型名
- [x] 3.3 为图片生成关闭 SDK 内建自动重试，接入 Run 截止时间、取消信号、稳定错误映射和安全 usage
- [ ] 3.4 使用 MockImageModel 和 fake LiteLLM 覆盖参数白名单、返回映射、取消、超时、不确定结果与敏感信息红线

## 4. C2 图片理解

- [ ] 4.1 为 Conversation Run 增加兼容的 `image.understand` 操作和 `image_asset` 输入校验
- [ ] 4.2 扩展 Context Planner，按显式资产引用、版本、派生 OCR/caption 和视觉预算选择上下文
- [ ] 4.3 实现视觉能力拒绝、逐图错误、处理范围和可选结构化结果校验
- [ ] 4.4 增加截图、OCR、表格、文档照片、多图关联和跨 Run 图片引用的确定性与真实模型评测

## 5. C2 图片生成

- [x] 5.1 为 Conversation Run 增加 `image.generate` 操作、提示词和通用图片选项校验
- [ ] 5.2 实现图片模型调用、输入/输出安全策略、生成结果落存和 Run/Message 资产引用事务
- [x] 5.3 实现 requestId 重放、生成边界、取消、资产写入失败和临时数据清理，验证不会重复生图或重复计费
- [x] 5.4 扩展 JSON Run 的 `artifacts` 和 POST SSE `artifact-created` 事件，并覆盖完成、拒绝、失败与断连顺序
- [ ] 5.5 使用 fake provider 和真实单模型 smoke test 验证图片有效性、提示词一致性、内容安全、耗时和成本证据
  - 2026-07-31 已完成单张图片有效性、提示词一致性观察和耗时证据；内容安全与成本证据未齐，任务保持未完成。

## 6. 渠道体验

- [x] 6.1 在现有 C1 会话输入区增加明确的图片理解/生图模式，不使用浏览器 provider 直连或纯文本猜测作为唯一入口
- [ ] 6.2 接入受控资产上传、进度、数量与失败项展示，并以 `image_asset` 恢复会话图片
- [ ] 6.3 展示生成阶段、图片产物、下载和稳定失败建议，验证桌面、390px 移动端、键盘和可访问性基线

## 7. 观测、文档与收口

- [ ] 7.1 增加 C2 阶段、模型别名、媒体用量、生成张数、成本与稳定错误类别，验证图片、提示词和临时 URL 不进入 Trace
- [x] 7.2 同步 README、AI SDK 对齐、场景链路、架构边界测试和运维说明，严格区分已实现、真实验证与 TODO
- [x] 7.3 运行定向测试、`npm test`、视觉评测、`openspec validate --specs --strict`、change strict validation 和 `git diff --check`
- [ ] 7.4 在全部任务和真实验收完成后吸收稳定 spec，并按仓库 OpenSpec 治理收尾活动 change

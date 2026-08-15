## 1. 方案与契约

- [x] 1.1 核对 Image API 与 Responses 图片工具的官方边界，并完成当前 LiteLLM 对照 PoC
- [x] 1.2 建立替代 `/images/edits` 的接受状态方案决策，记录采用、未采用、退出和重评条件
- [x] 1.3 增加独立 `image.edit` OpenSpec 增量规格

## 2. 受控源图片资产

- [x] 2.1 迁移 `image_assets` 以支持无 Run 上传资产，并保持既有生成资产和消息关联
- [x] 2.2 实现 Runtime 图片上传、真实格式/尺寸/字节校验、原子落存和失败清理
- [x] 2.3 实现 Demo Server 二进制上传入口及跨会话、缺失、类型和大小错误

## 3. 图片编辑主链

- [x] 3.1 增加 `image.edit` 输入判别、一张 `image_asset` 引用和图片选项白名单
- [x] 3.2 将 GatewayClient `editImages` 改为经 LiteLLM `/v1/responses` 调用 `image_generation.action=edit`，且固定单次尝试
- [x] 3.3 Runtime 读取源资产字节、执行编辑、校验并持久化新 `image_asset`
- [x] 3.4 继承 requestId 重放、取消、超时、错误脱敏、清理和 SSE 资产交付

## 4. 渠道体验

- [x] 4.1 Runtime Adapter 增加受控图片上传方法
- [x] 4.2 Demo 增加“图生图”模式，要求一张本地图片和非空编辑指令
- [x] 4.3 会话消息恢复源图片引用，并区分上传源图与生成/编辑产物
- [x] 4.4 编辑成功后承接最新输出资产，并为历史图片结果提供“继续编辑”

## 5. 验证与文档

- [x] 5.1 增加 Gateway Responses、连续两轮资产、Runtime 幂等/权限/失败、HTTP 和 Adapter 回归
- [x] 5.2 运行定向测试、完整 `npm test`、Demo 构建/预算和 `git diff --check`
- [ ] 5.3 修复 delta 中两个 MODIFIED requirement 缺失既有 scenario 的问题后，重新执行 `openspec validate add-c2-image-editing --strict`；2026-08-15 固定 CLI 验证已准确暴露该契约合并错误
- [x] 5.4 更新 README、场景链、AI SDK 对齐和决策索引，明确真实模型与生产治理剩余边界
- [x] 5.5 执行三次真实 `/images/edits` smoke，记录上游无兼容账号和 LiteLLM 图片重试修正证据
- [x] 5.6 执行 Responses 文本/图片工具对照 PoC，记录文本成功和图片工具权限被拒绝证据
- [x] 5.7 2026-08-15 使用当前 `gpt-5.6` 配置完成两轮 A→B→C 真实编辑；第二轮只引用第一轮输出，三个 PNG 哈希不同，刷新后两个输出仍可读取
- [x] 5.8 2026-08-15 使用无业务信息合成图完成 Responses 约束字段对照；`action=edit` 与增加 `tool_choice` 均返回 200，当前中转站在增加 `max_tool_calls=1` 后返回 502，因此 Adapter 保留强制工具选择并由唯一结果解析收口

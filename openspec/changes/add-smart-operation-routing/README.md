# add-smart-operation-routing

本 change 把新 Run 的默认请求操作改为 `auto`，并把首版“只看当前消息与附件”的分类升级为会话上下文感知路由。Agent Runtime 从已提交 Message、真实 Run operation 和 `image_asset` 事实派生活动图片，读取有界 routing snapshot，再使用 AI SDK `Output.object` 获得 `operation / confidence / useActiveImage / relevantMessageIds`。Runtime 校验证据、选择实际源图并组装业务输入；图片生成和编辑只在候选合法且置信度不低于 `0.85` 时执行。

显式当前附件始终优先；无当前附件但存在活动图片时可以候选视觉对话、全新生成或继续编辑。无效证据、失效资产、低置信度、分类子截止时间耗尽或其他非取消分类失败回退不继承历史图片的 `conversation.chat`，不得产生图片副作用。显式历史图片“继续编辑”和 `retry / regenerate / continue` 恢复不重新分类。Run 持久化真实 operation、实际引用与脱敏 intentDecision，并按真实 operation 选择服务端默认模型别名。

验证分为独立的 deterministic 与 real-model 意图路由模式：前者验证 Runtime/Store/资产链，后者只替换分类器并继续使用 fake 图片模型；两类结果不得合并为同一准确率。

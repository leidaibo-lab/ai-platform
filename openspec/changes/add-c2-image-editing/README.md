# add-c2-image-editing

本 change 在既有 C2 `image_asset` 与文生图开发切片上增加独立 `image.edit` 操作。编辑经 LiteLLM Responses `image_generation(action=edit)` 执行，每轮输出资产可继续作为下一轮唯一源图。首期仅支持一张受控源图和文本编辑指令，不包含遮罩、局部重绘、多图融合或远程 URL 导入。

验证入口：

```bash
node --test scripts/test-image-generation.mjs scripts/test-gateway-client.mjs scripts/test-streaming-http.mjs scripts/test-demo-adapter.mjs
openspec validate add-c2-image-editing --strict
```

如果本机没有 `openspec` CLI，仍需运行仓库测试并在交付说明中明确记录该验证缺口。

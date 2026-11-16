# Custom Exploration

这里保留 AI 应用基础平台 v1 的自研探索实现：Runtime、浏览器 Demo、LiteLLM 网关实验、场景、评测和 pi 适配实验。它用于研究会话、上下文、工具调用、恢复与执行治理的设计取舍。

根目录已在 v2.0 切换为 Mastra 主线。本目录不是根应用的运行依赖；其中的 Runtime、GatewayClient、SQLite Store、天气、图片和会话能力不得自动视为 Mastra 的能力。

## 独立运行

在本目录使用自己的依赖、环境样例和数据目录：

```bash
cd /Users/Administrator/self-code/ai-platform/practices/custom-exploration
npm ci
cp .env.example .env
```

具体 Demo、LiteLLM 和场景命令以本目录 `package.json`、`demo/`、`scenarios/` 和 `AGENTS.md` 为准。不要复用根目录 `.env`、`.data/` 或 Mastra 的依赖树。

## 归档边界

- 旧稳定契约与探索变更位于 `openspec/`。
- 旧架构、运行可靠性、上下文和场景文档位于 `docs/`。
- `experiments/pi-agent/` 是自研 Runtime 的 pi 适配实验，不是 pi 原生应用。
- 有价值的结论进入根主线前，需要重新形成主线 OpenSpec、实现和验证，不能仅靠本目录历史测试。

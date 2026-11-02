# pi-agent 隔离对比 PoC

本目录属于**探索方向**，研究 pi 如何适配已有平台契约；它不是 pi 原生应用示例。原生学习与应用入口位于[应用实践集合 / pi](../../practices/pi/README.md)，两者分别记录结果，不互相替代。

这个目录比较 `@earendil-works/pi-agent-core@1.2.0` 与当前 AI SDK Core 路径，并单独验证 `pi-durable@1.2.0`。它不属于 Demo 启动入口，不读取 `.env`。文本/图片对比使用假 LiteLLM HTTP fixture；durable 使用官方内存 faux provider，没有真实网络或模型费用。

## 运行

```bash
nvm use
npm ci --prefix experiments/pi-agent --ignore-scripts
node --test experiments/pi-agent/test-comparison.mjs
npm test --prefix experiments/pi-agent
```

项目运行时基线为 Node `>=24.0.0`；pi 1.2.0 本身声明 Node `>=22.19.0`，因此满足项目基线。`.nvmrc` 选择 Node 24。运行前用 `node --version` 与 `npm exec -- node --version` 核对直接执行和 npm 子进程版本；未使用 nvm 时可通过其他版本管理器选择 Node 24。

## 覆盖范围

- `ai-sdk` 和 `pi` 使用同一个 OpenAI-compatible 假网关、天气 Connector 和项目 SQLite Runtime。
- 通过原 Runtime 验证工具 allowlist、ToolResult、AcceptanceResult、幂等和进程恢复。
- 通过 pi Adapter 验证工具循环、流式事件、取消、工具前重试和工具后无工具总结恢复。
- 动态 `Output.object` 仍由原 GatewayClient 处理，明确记录为 Pi 不承担的能力。
- 进程崩溃场景由项目 SQLite/RunLease 恢复；没有把 pi 的存储当成第二事实源。

## 当前结果

后续验证：Node 24.19.0 下完整 PoC **51/51**（原有对比 22、协议/治理边界 18、pi-durable 独立持久化 6、父子任务生命周期 5）。包含对视觉适配缺口与非幂等 safe 工具重复操作的明确断言，这些测试符合预期不等于候选能力满足迁移门槛。详细结果、删除/新增清单、许可证声明及真实模型阻塞见[后续验证报告](../../docs/audits/2026-10-13-pi-followup-verification.md)。

2026-10-13：22/22 通过（两种引擎各 11 个）。结果只证明在固定协议和故障 fixture 下可以适配，不证明真实模型质量、生产多实例、pi-durable 生产稳定性或图片链路兼容性。

先前“测试在 Node 20 执行”的说明有误：当时直接 `node` 为 24.19.0，Node 20.16.0 警告来自 PoC 目录中的 npm 安装进程。此次显式指定 Node 24.19.0，并统一 npm 的子进程 PATH，重新 `npm ci --ignore-scripts` 无引擎警告，PoC 22/22、项目回归 165/165、Demo 构建/资源预算和 OpenSpec strict 全部通过。详细命令与边界见[选型记录](../../docs/decisions/2026-10-13-pi-agent-isolated-comparison.md)。

父子任务追加验证使用无模型 custom tasks，覆盖 waiting checkpoint 真实进程恢复、allSettled、failFast、bottom-up 取消和独立 background scope；不代表真实模型子 Agent、多实例或数小时稳定性。

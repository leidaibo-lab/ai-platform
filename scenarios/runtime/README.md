# Runtime 场景协议

`scenarios/runtime/` 保存可版本化、可重复执行的 Runtime 场景资产。场景与通用 Runner 分离：新增业务案例优先增加场景目录，不在 Runner 中增加业务关键词或答案分支。

## 资产结构

```text
scenarios/runtime/
  schema.json
  <scenario-id>/
    case.json
    deterministic-model.mjs
    acceptance.mjs
    README.md
```

- `case.json`：声明 `runtime-scenario.v1`、fixture 版本、支持模式、Prompt 版本、固定生成参数、Run 输入、故障点和只读 ToolResult fixture。
- `deterministic-model.mjs`：根据当前模型请求中可见的消息和 ToolResult 返回标准 Tool Call 或文本，不读取 Runner 隐藏轮次。
- `acceptance.mjs`：只读取 Runner 提供的持久化观察结果，独立判断场景是否通过。
- `README.md`：说明场景证明什么，以及不能证明什么。

## 双模式

```text
setup
  固定行为模型 -> 现有 Runtime / Tool Registry -> completed ToolResult -> 进程退出

evaluation
  deterministic -> 固定行为模型 -> Runtime / SQLite / 验收回归
  real-model    -> GatewayClient -> AI SDK -> LiteLLM -> 上游模型 -> 质量观察
```

两种模式复用同一份输入、ToolResult fixture、故障点和验收器。真实模式只把 `evaluation` 计入模型质量、token 和延迟；`setup` 单独报告。真实调用失败直接失败，禁止回退固定模型或重放 Connector。

## 执行

```bash
npm run test:scenarios
npm run eval:runtime-scenarios:deterministic
npm run eval:runtime-scenarios:real
```

项目级真实评测命令固定使用 `gpt-5.6`，避免重复评测时模型漂移。直接调用 CLI 或接入其他 AI 项目时，调用方必须显式固定自己的模型别名：

```bash
node scripts/run-runtime-scenarios.mjs \
  --mode real-model \
  --model <fixed-model-alias> \
  --scenario weather-restart-accepted
```

报告写入 `.data/evaluations/runtime-scenarios-<mode>.json`，使用 `runtime-scenario-report.v1`。每个场景分别记录：

- fixture、Prompt 和固定生成参数版本。
- 请求模型别名，以及只从成功响应读取的可空实际模型。
- setup/evaluation 的请求数、完成响应数、失败数和阶段耗时。
- evaluation 成功响应的 token、Run 状态、恢复事实和独立验收结果。

旁路证据不保存 Prompt、回答、ToolResult、密钥或 provider 原始响应体。真实样本不足 30 时报告固定为 `observation-only`，不能作为质量发布基线。

## 扩展与复用

Runner 使用现有生产 `Chat Runtime`、SQLite Store、GatewayClient 和 Tool Registry，只在 Model Port 与声明式只读 Connector fixture 处注入测试依赖。当前不新增 Runtime Client/Server、Operation Engine、独立服务或发布包。

同仓扩展时直接新增符合 `runtime-scenario.v1` 的目录资产。独立 AI 项目复用时，保持 case、固定模型、Acceptance 和报告语义不变，通过装配层接入该项目自己的 Runtime/Store/Gateway；出现第二个稳定消费方后，再把协议、通用调度和项目装配分层发布，避免现在提前形成无人维护的公共包。

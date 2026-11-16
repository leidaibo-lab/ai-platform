#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 使用表驱动契约测试：规则表声明受保护资产和必需节点，reviewer 测试统一执行排除与包含断言。
 * 该检查只约束架构表达，不参与 Runtime 或模型网关的运行时调用。
 */

/**
 * @typedef {object} ArchitectureAssetRule
 * @property {string} path 项目根目录下的文本资产路径。
 * @property {readonly string[]} [requiredLabels] 业务主链资产必须包含的节点标签。
 */

const PROJECT_ROOT = new URL("../", import.meta.url);
const DIAGNOSTIC_LABELS = Object.freeze([
  "scripts/test-chat.sh",
  "纯模型客户端",
  "普通客户端",
  "内部脚本",
  "smoke test",
]);

/** @type {readonly ArchitectureAssetRule[]} */
const GLOBAL_ARCHITECTURE_ASSETS = Object.freeze([
  {
    path: "docs/assets/ai-platform-global-chain-v2.svg",
    requiredLabels: ["Agent Runtime", "GatewayClient", "AI SDK", "LiteLLM Proxy", "上游"],
  },
  {
    path: "docs/assets/ai-platform-data-flow-v3.html",
    requiredLabels: ["Agent Runtime", "GatewayClient", "AI SDK", "LiteLLM", "上游"],
  },
  {
    path: "docs/scenario-interaction-chains.md",
    requiredLabels: ["Agent Runtime", "GatewayClient", "AI SDK", "LiteLLM", "上游"],
  },
  {
    path: "docs/assets/ai-platform-current-runtime-v1.svg",
    requiredLabels: ["Agent Runtime", "GatewayClient", "AI SDK", "LiteLLM Proxy", "上游"],
  },
  { path: "docs/assets/ai-platform-architecture.svg" },
  { path: "docs/assets/ai-platform-roadmap.svg" },
  { path: "docs/assets/ai-platform-current-v05.svg" },
]);

const SCENARIO_CHAIN_LABELS = Object.freeze([
  "C1 对话问答",
  "C2 图片理解、生成与编辑",
  "C3 文档知识问答",
  "C4 业务数据查询",
  "C5 实时事件处理",
  "C6 操作执行",
  "C7 批量分析",
]);

/** 读取项目内文本资产，统一使用 UTF-8 供架构契约断言。 */
async function readProjectText(relativePath) {
  return readFile(new URL(relativePath, PROJECT_ROOT), "utf8");
}

/** 验证全局架构资产没有把模型连通性诊断画成平台能力。 */
async function testGlobalAssetsExcludeDiagnostics() {
  for (const rule of GLOBAL_ARCHITECTURE_ASSETS) {
    const content = await readProjectText(rule.path);
    for (const label of DIAGNOSTIC_LABELS) {
      assert.equal(content.includes(label), false, `${rule.path} 不得包含诊断链标签：${label}`);
    }
    for (const label of rule.requiredLabels ?? []) {
      assert.equal(content.includes(label), true, `${rule.path} 缺少业务主链节点：${label}`);
    }
  }
}

test("global architecture assets exclude model connectivity diagnostics", testGlobalAssetsExcludeDiagnostics);

/** 验证协作入口和稳定契约都声明 Runtime 是唯一业务模型调用入口。 */
async function testGovernanceKeepsRuntimeBoundary() {
  const agents = await readProjectText("AGENTS.md");
  const specification = await readProjectText("openspec/specs/ai-platform/spec.md");

  assert.match(agents, /业务模型请求统一经过 Agent Runtime/);
  assert.match(agents, /测试链.*不属于全局能力规划/);
  assert.match(specification, /唯一平台业务主链/);
  assert.match(specification, /scripts\/test-chat\.sh -> LiteLLM -> 上游模型.*SHALL NOT/);
}

test("governance keeps Agent Runtime as the sole business model path", testGovernanceKeepsRuntimeBoundary);

/** 验证稳定对话/编辑别名映射到已验证上游，并让图片副作用保持网关零重试。 */
async function testGatewayModelMappings() {
  const config = await readProjectText("config.yaml");

  assert.match(
    config,
    /  - model_name: gpt-5\.6\n    litellm_params:\n      model: openai\/gpt-5\.6-sol\n      api_base: os\.environ\/UPSTREAM_API_BASE\n      api_key: os\.environ\/UPSTREAM_API_KEY1\n      num_retries: 0/,
  );
  assert.match(
    config,
    /  - model_name: gpt-image-2\n    litellm_params:\n      model: openai\/gpt-image-2\n      api_base: os\.environ\/UPSTREAM_API_BASE\n      api_key: os\.environ\/UPSTREAM_API_KEY2\n      num_retries: 0/,
  );
}

test("gateway keeps verified model mappings and disables image side-effect retries", testGatewayModelMappings);

/** 验证场景治理文档保留 C1 功能焦点、分阶段恢复边界和 ChainTrace 延期口径。 */
async function testScenarioChainsKeepCurrentFocus() {
  const content = await readProjectText("docs/scenario-interaction-chains.md");

  assert.match(content, /共同底座是七条场景链路的必要条件，但不是充分条件/);
  assert.match(content, /重试是共同底座的横切稳定性能力/);
  assert.match(content, /服务端工具 allowlist/);
  assert.match(content, /Runtime 只在明确地点的今明日天气命中确定性路由时向模型开放 `get_weather`/);
  assert.match(content, /A3 天气候选先提交验收终态再发布正文，订阅或渠道失败不反向改写 Run/);
  assert.match(content, /SQLite `conversation_events` 只记录已提交事实，两类事件不能互相充当事实源/);
  assert.match(content, /Open-Meteo 查询共享 Run 截止时间和取消信号/);
  assert.match(content, /不等于任何失败都从浏览器输入开始完整重跑/);
  assert.match(content, /默认 `maxAttempts: 3`，即首次调用加两次重试/);
  assert.match(content, /Runtime 通过进程内 `RunEventSink` 发布易失生命周期事件，Demo Server Adapter 映射为 `POST \.\.\.\/runs\/stream` SSE/);
  assert.match(content, /开始输出后不静默重生成/);
  assert.match(content, /C1 不逐 Token 写 SQLite，也不保存回答 checkpoint/);
  assert.match(content, /当前建设焦点：C1 功能可用与确定性回归/);
  assert.match(content, /正式实例和真实 Runtime Trace 验收按触发条件恢复/);
  assert.match(content, /不再作为当前功能迭代或其他低风险场景调研的硬门禁/);
  assert.match(content, /这不代表 C2-C7 已经可用/);
  assert.match(content, /正式实例上的真实 Runtime JSON\/SSE Trace 尚未验收/);
  assert.doesNotMatch(content, /V0\.6 已跑通 Demo 和正式 ChainTrace/);
  assert.doesNotMatch(content, /C1 渠道可按模型决策调用服务端 `get_weather`/);
  assert.doesNotMatch(content, /未来只读 Connector/);
  assert.doesNotMatch(content, /未实现真实工具循环和人工确认/);
  for (const label of SCENARIO_CHAIN_LABELS) {
    assert.match(content, new RegExp(label), `场景治理文档缺少链路：${label}`);
  }
}

test("scenario chains keep C1 focus and defer runtime trace acceptance", testScenarioChainsKeepCurrentFocus);

/** 验证 Runtime 只发布内部生命周期事件，SSE 协议映射留在渠道 Adapter。 */
async function testRuntimeEventPortKeepsChannelBoundary() {
  const runtime = await readProjectText("src/runtime/chat-runtime.mjs");
  const eventSink = await readProjectText("src/runtime/run-event-sink.mjs");
  const adapter = await readProjectText("scripts/demo-server.mjs");

  assert.match(runtime, /eventSink\.publish/);
  assert.doesNotMatch(runtime, /writeSseEvent|text\/event-stream|onRunStarted|onToolEvent|onArtifactCreated/);
  assert.match(eventSink, /订阅失败不得向 Runtime 反向传播/);
  assert.match(adapter, /createSseRunEventSubscriber/);
  assert.match(adapter, /writeSseEvent\(res, "text-delta"/);
}

test("Runtime event port keeps SSE inside the channel adapter", testRuntimeEventPortKeepsChannelBoundary);

/** 验证普通 Composer 不再把 Runtime operation 和模型选择责任暴露给用户。 */
async function testDemoDelegatesOrdinaryRoutingToRuntime() {
  const app = await readProjectText("demo/src/App.jsx");
  const stableSpec = await readProjectText("openspec/specs/ai-platform/spec.md");

  assert.doesNotMatch(app, /选择运行模式|sender-mode-select|高级覆盖/);
  assert.doesNotMatch(app, /aria-label="选择模型"/);
  assert.match(app, /const \[composerMode, setComposerMode\] = useState\("auto"\)/);
  assert.match(app, /setComposerMode\("image\.edit"\)/);
  assert.match(app, /setComposerMode\("auto"\)/);
  assert.match(stableSpec, /Demo SHALL NOT 要求用户选择“对话 \/ 生图 \/ 图生图”模式或模型别名/);
}

test("Demo delegates ordinary operation routing to Runtime", testDemoDelegatesOrdinaryRoutingToRuntime);

/** 验证当前架构图与核心说明保持执行治理角色分离和未完成能力门禁。 */
async function testExecutionGovernanceArchitectureBoundary() {
  const currentDiagram = await readProjectText("docs/assets/ai-platform-current-runtime-v1.svg");
  const architecture = await readProjectText("docs/ai-structure.md");
  const reliability = await readProjectText("docs/runtime-reliability-and-acceptance.md");
  const readme = await readProjectText("README.md");

  for (const [path, content] of [
    ["docs/assets/ai-platform-current-runtime-v1.svg", currentDiagram],
    ["docs/ai-structure.md", architecture],
    ["docs/runtime-reliability-and-acceptance.md", reliability],
    ["README.md", readme],
  ]) {
    assert.match(content, /ExecutionPolicy/, `${path} 缺少 ExecutionPolicy 当前能力`);
    assert.match(content, /Operation [Jj]ournal/, `${path} 缺少 Operation Journal 当前能力`);
    assert.match(content, /RunLease/, `${path} 缺少 RunLease 当前能力`);
    assert.match(content, /fencing/, `${path} 缺少 fencing 当前能力`);
  }

  assert.match(currentDiagram, /只决策与观察；不读写事实/);
  assert.match(currentDiagram, /Store 独占事实/);
  assert.match(currentDiagram, /Connector 只执行 Runtime 已授权的归一化请求/);
  assert.match(currentDiagram, /后续安全门禁（TODO，不在当前执行主链）/);
  assert.match(currentDiagram, /Sandbox　\|　生产多实例部署与跨实例取消/);
  assert.match(currentDiagram, /写操作确认 \/ 外部幂等 \/ readback \/ unknown 人工处理 \/ compensation/);
  assert.doesNotMatch(currentDiagram, /多实例协调：未实现|无 Operation journal|Tool Registry \/ Policy Gate/);

  assert.match(architecture, /生产级多实例部署.*当前 lease\/fencing 只完成 SQLite 协调基础与确定性接管验证/);
  assert.match(architecture, /Sandbox.*当前没有写 Connector/);
  assert.match(reliability, /不单独提升场景等级的 R4 协调基础/);
  assert.match(reliability, /还没有共享生产数据库部署、跨实例取消路由/);
  assert.match(reliability, /Sandbox 与副作用恢复仍是两条独立建设线/);
  assert.match(readme, /不等于通用持久工作流或生产级多实例协调/);
  assert.match(readme, /生产级协调演练尚未完成/);
}

test("execution governance architecture keeps cohesion and gated boundaries", testExecutionGovernanceArchitectureBoundary);

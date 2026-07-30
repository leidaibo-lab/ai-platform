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
  { path: "docs/assets/ai-platform-architecture.svg" },
  { path: "docs/assets/ai-platform-roadmap.svg" },
  { path: "docs/assets/ai-platform-current-v05.svg" },
]);

const SCENARIO_CHAIN_LABELS = Object.freeze([
  "C1 对话问答",
  "C2 图片理解",
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

/** 验证场景治理文档保留 C1 功能焦点、分阶段恢复边界和 ChainTrace 延期口径。 */
async function testScenarioChainsKeepCurrentFocus() {
  const content = await readProjectText("docs/scenario-interaction-chains.md");

  assert.match(content, /共同底座是七条场景链路的必要条件，但不是充分条件/);
  assert.match(content, /重试是共同底座的横切稳定性能力/);
  assert.match(content, /不等于任何失败都从浏览器输入开始完整重跑/);
  assert.match(content, /默认 `maxAttempts: 3`，即首次调用加两次重试/);
  assert.match(content, /`POST \.\.\.\/runs\/stream` 通过 SSE 交付 AI SDK 文本增量/);
  assert.match(content, /开始输出后不静默重生成/);
  assert.match(content, /C1 不逐 Token 写 SQLite，也不保存回答 checkpoint/);
  assert.match(content, /当前建设焦点：C1 功能可用与确定性回归/);
  assert.match(content, /正式实例和真实 Runtime Trace 验收按触发条件恢复/);
  assert.match(content, /不再作为当前功能迭代或其他低风险场景调研的硬门禁/);
  assert.match(content, /这不代表 C2-C7 已经可用/);
  assert.match(content, /正式实例上的真实 Runtime JSON\/SSE Trace 尚未验收/);
  assert.doesNotMatch(content, /V0\.6 已跑通 Demo 和正式 ChainTrace/);
  for (const label of SCENARIO_CHAIN_LABELS) {
    assert.match(content, new RegExp(label), `场景治理文档缺少链路：${label}`);
  }
}

test("scenario chains keep C1 focus and defer runtime trace acceptance", testScenarioChainsKeepCurrentFocus);

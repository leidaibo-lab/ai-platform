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
  { path: "docs/assets/ai-platform-architecture.svg" },
  { path: "docs/assets/ai-platform-roadmap.svg" },
  { path: "docs/assets/ai-platform-current-v05.svg" },
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

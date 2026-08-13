#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runRuntimeScenarioSuite } from "../src/evaluation/runtime-scenario-runner.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("deterministic runtime scenario suite passes accepted and rejected recovery cases", testDeterministicScenarioSuite);
test("deterministic runtime scenarios can persist an explicit evaluation alias", testExplicitDeterministicAlias);
test("real-model runtime scenarios require an explicit model alias", testRealModelRequiresAlias);
test("real-model npm entry leaves the model alias to the caller", testRealModelNpmEntryRequiresAlias);
test("real-model failures do not report a requested alias as the actual model", testFailedRealModelEvidence);
test("real-model successful responses keep nullable model metadata", testSuccessfulRealModelWithoutMetadata);

/** 验证确定性模式完整执行两个进程级恢复场景且不重放 Connector。 */
async function testDeterministicScenarioSuite() {
  const report = await runRuntimeScenarioSuite({ rootDir, mode: "deterministic" });
  const failedChecks = report.scenarios.flatMap(readFailedChecks);

  assert.equal(report.schemaVersion, "runtime-scenario-report.v1");
  assert.equal(report.resultClass, "execution-regression");
  assert.equal(report.summary.passed, 2);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.skipped, 0);
  assert.equal(report.scenarios.every(hasMeasuredPhaseDurations), true);
  assert.equal(report.latency.coverage, "evaluation-phase-end-to-end");
  assert.deepEqual(report.scenarios[0].evaluationParameters, {
    temperature: 1,
    maxCompletionTokens: 2000,
  });
  assert.deepEqual(failedChecks, []);
  assert.deepEqual(report.scenarios.map(readScenarioId), [
    "weather-restart-accepted",
    "weather-restart-rejected",
  ]);
  assert.equal(report.scenarios.every(hasNoConnectorReplay), true);
  assert.deepEqual(report.models.actual, [
    "deterministic-weather-accepted-v1",
    "deterministic-weather-rejected-v1",
  ]);
  assert.equal(report.scenarios.every(hasOneEvaluationModelCall), true);
  assert.equal(report.scenarios.every(hasOneSetupModelCall), true);
  assert.equal(report.scenarios.every(hasNoModelRequestFailures), true);
}

/** 验证固定模型准备阶段可写入显式别名，供真实恢复阶段沿用原 Run 模型。 */
async function testExplicitDeterministicAlias() {
  const report = await runRuntimeScenarioSuite({
    rootDir,
    mode: "deterministic",
    modelAlias: "explicit-evaluation-alias",
    scenarioIds: ["weather-restart-accepted"],
  });

  assert.equal(report.summary.passed, 1);
  assert.deepEqual(report.models.aliases, ["explicit-evaluation-alias"]);
  assert.deepEqual(report.models.actual, ["deterministic-weather-accepted-v1"]);
  assert.equal(report.scenarios[0].modelAlias, "explicit-evaluation-alias");
  assert.equal(report.scenarios[0].actualModel, "deterministic-weather-accepted-v1");
  assert.deepEqual(report.scenarios[0].setup.actualModels, ["deterministic-weather-accepted-v1"]);
  assert.equal(report.scenarios[0].modelCallCount, 1);
}

/** 验证真实模式缺少固定模型别名时在任何网关调用前直接拒绝。 */
async function testRealModelRequiresAlias() {
  await assert.rejects(
    runRuntimeScenarioSuite({ rootDir, mode: "real-model" }),
    isExplicitModelAliasError,
  );
}

/** 验证 npm 入口不内置模型别名，由调用方为每次真实评测显式固定。 */
async function testRealModelNpmEntryRequiresAlias() {
  const packageJson = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["eval:runtime-scenarios:real"],
    "node scripts/run-runtime-scenarios.mjs --mode real-model",
  );
}

/** 验证真实网关未完成响应时只记录请求别名，不伪造上游实际模型证据。 */
async function testFailedRealModelEvidence() {
  const originalFetch = globalThis.fetch;
  /** 返回不可重试的鉴权失败，模拟没有任何 completed chat completion 的真实网关调用。 */
  async function rejectModelRequests() {
    return new Response(JSON.stringify({ error: { message: "intentional scenario test failure" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  globalThis.fetch = rejectModelRequests;
  try {
    const report = await runRuntimeScenarioSuite({
      rootDir,
      mode: "real-model",
      modelAlias: "requested-model-without-response",
      scenarioIds: ["weather-restart-accepted"],
    });

    assert.equal(report.summary.failed, 1);
    assert.deepEqual(report.models.aliases, ["requested-model-without-response"]);
    assert.deepEqual(report.models.actual, []);
    assert.equal(report.scenarios[0].modelAlias, "requested-model-without-response");
    assert.equal(report.scenarios[0].actualModel, null);
    assert.equal(report.scenarios[0].modelRequestCount, 1);
    assert.equal(report.scenarios[0].modelCallCount, 0);
    assert.equal(report.scenarios[0].modelFailureCount, 1);
    assert.equal(report.scenarios[0].setup.modelCallCount, 1);
    assert.equal(report.scenarios[0].run.errorCode, "model_authorization_failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** 验证成功 completion 缺少 model/usage 时仍计为完成，且不推断实际模型或 token。 */
async function testSuccessfulRealModelWithoutMetadata() {
  const originalFetch = globalThis.fetch;
  /** 返回可被 AI SDK 消费的成功响应，但故意省略 provider 模型名和 usage。 */
  async function respondWithoutModelMetadata(input) {
    const url = input instanceof Request ? input.url : String(input);
    const pathname = new URL(url).pathname;
    if (pathname === "/utils/token_counter") {
      return jsonResponse({ total_tokens: 32 });
    }
    if (pathname === "/v1/chat/completions") {
      return jsonResponse({
        id: "metadata-optional-completion",
        object: "chat.completion",
        created: 1720000002,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "深圳在 2026-08-13 10:00 的气温为 31℃，天气局部多云；数据来源 Open-Meteo。",
            },
            finish_reason: "stop",
          },
        ],
      });
    }
    return jsonResponse({ error: { message: "unexpected scenario endpoint" } }, 404);
  }
  globalThis.fetch = respondWithoutModelMetadata;
  try {
    const report = await runRuntimeScenarioSuite({
      rootDir,
      mode: "real-model",
      modelAlias: "requested-model-with-nullable-metadata",
      scenarioIds: ["weather-restart-accepted"],
    });

    assert.equal(report.summary.passed, 1);
    assert.deepEqual(report.models.actual, []);
    assert.equal(report.scenarios[0].actualModel, null);
    assert.equal(report.scenarios[0].modelRequestCount, 1);
    assert.equal(report.scenarios[0].modelCallCount, 1);
    assert.equal(report.scenarios[0].modelFailureCount, 0);
    assert.equal(report.scenarios[0].usage.totalTokens, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** 创建 JSON Response，供真实模式测试替代上游端点。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 判断错误是否来自真实评测模型版本门禁。 */
function isExplicitModelAliasError(error) {
  return error instanceof TypeError && error.message === "real-model mode requires an explicit model alias";
}

/** 返回一个场景中未通过检查的带场景 ID 名称。 */
function readFailedChecks(scenario) {
  return scenario.acceptance.checks.filter(isFailedCheck).map(
    /** 组合场景与检查名，便于默认测试直接定位资产。 */
    (check) => `${scenario.id}:${check.name}`,
  );
}

/** 判断应用验收检查是否失败。 */
function isFailedCheck(check) {
  return !check.passed;
}

/** 返回场景稳定 ID。 */
function readScenarioId(scenario) {
  return scenario.id;
}

/** 判断重启后的 Runtime 没有再次进入 Connector Port。 */
function hasNoConnectorReplay(scenario) {
  return scenario.connectorExecutionsAfterRestart === 0;
}

/** 判断最终答案评测阶段只有一次已完成模型响应。 */
function hasOneEvaluationModelCall(scenario) {
  return scenario.modelRequestCount === 1 && scenario.modelCallCount === 1;
}

/** 判断故障稳定点由一次固定模型 Tool Call 构造。 */
function hasOneSetupModelCall(scenario) {
  return scenario.setup?.mode === "deterministic"
    && scenario.setup.modelRequestCount === 1
    && scenario.setup.modelCallCount === 1;
}

/** 判断 setup 与 evaluation 均没有模型请求失败事件。 */
function hasNoModelRequestFailures(scenario) {
  return scenario.modelFailureCount === 0 && scenario.setup?.modelFailureCount === 0;
}

/** 判断故障构造和最终回答阶段都具有独立正耗时。 */
function hasMeasuredPhaseDurations(scenario) {
  return scenario.setup?.durationMs > 0 && scenario.evaluationDurationMs > 0;
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolveRuntimeRoutingConclusionPolicy,
  runRuntimeRoutingScenarioSuite,
} from "../src/evaluation/runtime-routing-scenario-runner.mjs";
import {
  loadRuntimeRoutingScenario,
} from "../src/evaluation/runtime-routing-scenario-contract.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scenarioDirectory = resolve(
  rootDir,
  "scenarios",
  "runtime-routing",
  "image-context-continuation",
);
const imageSideEffectFailureRoot = resolve(
  rootDir,
  "scenarios",
  "runtime-routing",
  ".test-fixtures",
  "image-side-effect-failure-suite",
);

test("runtime routing scenario keeps a no-active-image negative case", testNoActiveImageNegativeCase);
test("deterministic runtime routing scenario passes the complete context chain", testDeterministicRoutingSuite);
test("failed turns count actual image backend calls as wrong side effects", testFailedImageCallSideEffect);
test("real-model mode delegates only intent classification and remains observation-only", testRealModelClassifierIsolation);
test("real-model sample gate uses valid classifier samples at the 30-case boundary", testRealModelSampleGate);
test("real-model runtime routing scenarios require an explicit alias", testRealModelRequiresAlias);
test("real-model npm entry leaves the alias to the caller", testRealModelNpmEntryRequiresAlias);

/** 验证无活动图片负例与 gold 独立存在，防止“输出新图”关键词越权触发图片副作用。 */
async function testNoActiveImageNegativeCase() {
  const scenario = await loadRuntimeRoutingScenario(scenarioDirectory);
  const conversation = scenario.definition.conversations.find(hasNoAssets);
  const gold = scenario.gold.turns.find(isNoActiveImageGold);

  assert.ok(conversation);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].input.references.length, 0);
  assert.equal(gold.operation, "conversation.chat");
  assert.equal(gold.activeImage, null);
  assert.equal(gold.artifactCount, 0);
}

/** 验证固定分类 fixture 驱动真实 Runtime 完成 A→B→核查→C，并正确处理负例。 */
async function testDeterministicRoutingSuite() {
  const report = await runRuntimeRoutingScenarioSuite({
    rootDir,
    mode: "deterministic",
  });
  const scenario = report.scenarios[0];

  assert.equal(report.schemaVersion, "runtime-routing-report.v1");
  assert.equal(report.resultClass, "routing-execution-regression");
  assert.equal(report.conclusionPolicy, "regression-gate");
  assert.deepEqual(report.summary, {
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    turnCount: 4,
    classifierAttemptCount: 4,
    validClassifierSampleCount: 4,
    executionErrorCount: 0,
  });
  assert.equal(report.metrics.operationAccuracy, 1);
  assert.equal(report.metrics.sourceImageAccuracy, 1);
  assert.equal(report.metrics.sourceReferenceAccuracy, 1);
  assert.equal(report.metrics.sourceBytesAccuracy, 1);
  assert.equal(report.metrics.visualInputAccuracy, 1);
  assert.equal(report.metrics.editPromptHistoryAccuracy, 1);
  assert.equal(report.metrics.evidenceValidity, 1);
  assert.equal(report.metrics.activeImageAccuracy, 1);
  assert.equal(report.metrics.wrongImageSideEffectRate, 0);
  assert.deepEqual(scenario.classifierConfiguration, {
    promptVersion: "runtime-intent.v2",
    outputSchemaName: "runtime_run_intent_v2",
    decisionSchemaVersion: "run-intent-decision.v2",
    temperature: 0,
    maxCompletionTokens: 180,
    confidenceThreshold: 0.85,
  });
  assert.equal(scenario.turns[0].decision.schemaVersion, "run-intent-decision.v2");
  assert.equal(scenario.turns[0].decision.routerVersion, "runtime-intent.v2");
  assert.equal(scenario.turns[0].decision.contextStrategyVersion, "routing-context.v2");
  assert.equal(report.usage.totalTokens > 0, true);
  assert.equal(report.latency.routing.sampleCount, 4);
  assert.equal(scenario.backend.imageEditCalls, 2);
  assert.equal(scenario.backend.imageGenerationCalls, 0);
  assert.equal(scenario.backend.chatCalls, 2);
  assert.equal(scenario.turns[0].sourceReferenceCorrect, true);
  assert.equal(scenario.turns[0].sourceBytesCorrect, true);
  assert.equal(scenario.turns[0].backendEvidence.imageEditSourceCount, 1);
  assert.equal(scenario.turns[0].backendEvidence.imageEditSourceSha256s.length, 1);
  assert.equal(scenario.turns[1].visualInputCorrect, true);
  assert.equal(scenario.turns[1].backendEvidence.chatImageCount, 1);
  assert.equal(scenario.turns[1].backendEvidence.chatImageSha256s.length, 1);
  assert.notEqual(
    scenario.turns[0].backendEvidence.imageEditSourceSha256s[0],
    scenario.turns[1].backendEvidence.chatImageSha256s[0],
  );
  assert.equal(
    scenario.turns[1].backendEvidence.chatImageSha256s[0],
    scenario.turns[2].backendEvidence.imageEditSourceSha256s[0],
  );
  assert.equal(scenario.turns[2].editPromptHistoryCorrect, true);
  assert.equal(scenario.turns[2].requiredPromptHistoryCount, 1);
  assert.equal(scenario.turns[2].routedPromptHistoryCount, 2);
  assert.equal(scenario.turns[2].backendEvidence.editPromptSha256s.length, 1);
  assert.equal(scenario.turns.at(-1).wrongImageSideEffect, false);
  assert.equal(scenario.turns.at(-1).actualArtifactCount, 0);
}

/** 验证图片调用一旦发生即计入副作用，即使固定图片后端随后抛错且无产物落库。 */
async function testFailedImageCallSideEffect() {
  const report = await runRuntimeRoutingScenarioSuite({
    rootDir: imageSideEffectFailureRoot,
    mode: "deterministic",
  });
  const scenario = report.scenarios[0];
  const turn = scenario.turns[0];
  const sideEffectCheck = scenario.checks.find(isWrongImageSideEffectCheck);

  assert.equal(scenario.status, "failed");
  assert.equal(turn.status, "failed");
  assert.equal(turn.actualArtifactCount, 0);
  assert.equal(turn.actualImageCallCount, 1);
  assert.equal(turn.wrongImageSideEffect, true);
  assert.equal(turn.backendEvidence.imageGenerationCallCount, 1);
  assert.equal(turn.backendEvidence.failedImageCallCount, 1);
  assert.equal(report.metrics.wrongImageSideEffectRate, 1);
  assert.equal(sideEffectCheck.passed, false);
}

/** 验证真实模式只有四次结构化分类委托，其余聊天和图片能力由固定后端处理。 */
async function testRealModelClassifierIsolation() {
  const classifier = createSequentialRealClassifier();
  const report = await runRuntimeRoutingScenarioSuite(
    {
      rootDir,
      mode: "real-model",
      modelAlias: "routing-real-test-model",
    },
    {
      /** 注入可观测分类 Gateway，若 Runner 误调用其他能力，测试对象不会提供对应方法。 */
      async createRealClassifierGateway() {
        return classifier.gatewayClient;
      },
    },
  );

  assert.equal(classifier.getCallCount(), 4);
  assert.equal(report.resultClass, "real-model-routing-quality");
  assert.equal(report.conclusionPolicy, "observation-only");
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.classifierAttemptCount, 4);
  assert.equal(report.summary.validClassifierSampleCount, 3);
  assert.deepEqual(report.actualClassifierModels, ["routing-real-test-model"]);
  assert.equal(report.usage.totalTokens, 21);
  assert.deepEqual(report.scenarios[0].classifier, {
    requested: 4,
    completed: 3,
    failed: 1,
    invalidOutput: 0,
    validSamples: 3,
    notRequired: 0,
  });
  assert.equal(report.scenarios[0].backend.imageEditCalls, 2);
  assert.equal(report.scenarios[0].backend.imageGenerationCalls, 0);
  assert.equal(report.metrics.wrongImageSideEffectRate, 0);
}

/** 验证真实模型结论门槛只接受有效分类样本，并在第 30 个样本才进入回归门禁。 */
function testRealModelSampleGate() {
  assert.equal(
    resolveRuntimeRoutingConclusionPolicy({
      mode: "real-model",
      validClassifierSampleCount: 29,
    }),
    "observation-only",
  );
  assert.equal(
    resolveRuntimeRoutingConclusionPolicy({
      mode: "real-model",
      validClassifierSampleCount: 30,
    }),
    "regression-gate",
  );
  assert.equal(
    resolveRuntimeRoutingConclusionPolicy({
      mode: "deterministic",
      validClassifierSampleCount: 0,
    }),
    "regression-gate",
  );
}

/** 验证真实模式缺少固定模型别名时在装配和网络调用前拒绝。 */
async function testRealModelRequiresAlias() {
  await assert.rejects(
    runRuntimeRoutingScenarioSuite({ rootDir, mode: "real-model" }),
    isExplicitModelAliasError,
  );
}

/** 验证 npm 真实评测入口不硬编码模型版本。 */
async function testRealModelNpmEntryRequiresAlias() {
  const packageJson = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["eval:runtime-routing:real"],
    "node scripts/run-runtime-routing-scenarios.mjs --mode real-model",
  );
}

/** 创建按调用序列返回结构化结果的模拟真实分类器，不读取用户正文关键词。 */
function createSequentialRealClassifier() {
  let callCount = 0;
  return {
    gatewayClient: {
      /** 从 Router 提供的结构化上下文取真实消息 ID，并返回当前序列的分类结果。 */
      async chatCompletions(input) {
        const payload = JSON.parse(input.messages[1].content);
        let output;
        if (callCount === 0) {
          output = {
            operation: "image.edit",
            confidence: 0.99,
            useActiveImage: false,
            relevantMessageIds: [],
          };
        } else if (callCount === 1) {
          output = {
            operation: "conversation.chat",
            confidence: 0.98,
            useActiveImage: true,
            relevantMessageIds: [payload.recentMessages[0].messageId],
          };
        } else if (callCount === 2) {
          output = {
            operation: "image.edit",
            confidence: 0.97,
            useActiveImage: true,
            relevantMessageIds: payload.recentMessages.slice(-2).map(readClassifierMessageId),
          };
        } else {
          callCount += 1;
          const error = new Error("simulated classifier failure");
          error.code = "classifier_fixture_failed";
          throw error;
        }
        callCount += 1;
        return {
          model: "routing-real-test-model",
          output,
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 7 },
        };
      },
    },
    /** 返回真实分类 Port 的调用次数。 */
    getCallCount() {
      return callCount;
    },
  };
}

/** 返回分类器上下文消息的稳定 ID。 */
function readClassifierMessageId(message) {
  return message.messageId;
}

/** 判断场景会话没有任何上传资产。 */
function hasNoAssets(conversation) {
  return conversation.assets.length === 0;
}

/** 判断 gold 轮次期望无活动图片且无图片产物。 */
function isNoActiveImageGold(turn) {
  return turn.activeImage === null && turn.artifactCount === 0;
}

/** 判断检查项是否为错误图片副作用率门禁。 */
function isWrongImageSideEffectCheck(check) {
  return check.name === "wrong-image-side-effect-rate";
}

/** 判断错误来自真实评测模型别名门禁。 */
function isExplicitModelAliasError(error) {
  return error instanceof TypeError
    && error.message === "real-model runtime routing scenarios require an explicit model alias";
}

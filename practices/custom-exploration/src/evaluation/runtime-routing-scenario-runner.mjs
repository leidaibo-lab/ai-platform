import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadDemoConfig } from "../config/env.mjs";
import { createGatewayClient } from "../gateway/gateway-client.mjs";
import { createChatRuntime } from "../runtime/chat-runtime.mjs";
import { createConversationCoordinator } from "../runtime/conversation-coordinator.mjs";
import { createContextPlanner } from "../runtime/context-planner.mjs";
import { estimateMessagesTokens } from "../runtime/context-budget.mjs";
import { createMemoryManager } from "../runtime/memory-manager.mjs";
import {
  RUN_INTENT_DECISION_SCHEMA_VERSION,
  RUN_INTENT_OUTPUT_SCHEMA_NAME,
  RUN_INTENT_ROUTER_VERSION,
  createRunIntentRouter,
} from "../runtime/run-intent-router.mjs";
import { createConversationStore } from "../storage/conversation-store.mjs";
import { createLocalImageAssetStore } from "../storage/image-asset-store.mjs";
import {
  RUNTIME_ROUTING_SCENARIO_MODES,
  discoverRuntimeRoutingScenarioDirectories,
  loadRuntimeRoutingScenario,
} from "./runtime-routing-scenario-contract.mjs";

export const RUNTIME_ROUTING_REPORT_VERSION = "runtime-routing-report.v1";

const DEFAULT_CONTEXT_OPTIONS = Object.freeze({
  maxContextTokens: 12000,
  reservedOutputTokens: 2000,
  safetyTokens: 500,
  highWatermarkRatio: 0.75,
  lowWatermarkRatio: 0.45,
  hardWatermarkRatio: 0.9,
});
const FIXED_CHAT_MODEL = "runtime-routing-chat-fixture-v1";
const FIXED_IMAGE_MODEL = "runtime-routing-image-fixture-v1";
const FIXED_CLASSIFIER_MODEL = "runtime-routing-classifier-fixture-v1";
const REPORT_SAMPLE_GATE = 30;

/**
 * @typedef {object} RuntimeRoutingAssembly
 * @property {object} runtime - 生产 ChatRuntime 实例。
 * @property {object} store - 当前场景独立的 SQLite 事实源。
 * @property {object} controller - 只按逻辑轮次读取 sidecar 的 fixture 控制器。
 * @property {object} observations - 分类调用与固定图片后端的旁路计数。
 * @property {() => Promise<void>} close - 释放 SQLite 和临时图片目录。
 */

/**
 * 装配真实 Runtime 主链；双模式只在 Intent Router 的分类模型 Port 上产生差异。
 * Facade 模式隔离分类模型与固定业务后端，防止真实模式误调用聊天或图片上游。
 *
 * @param {object} input - 场景、模式和临时存储参数。
 * @param {object} input.scenario - 已通过契约校验的场景。
 * @param {"deterministic"|"real-model"} input.mode - 当前分类执行模式。
 * @param {string} input.workingDirectory - 当前场景唯一临时目录。
 * @param {object} [input.realClassifierGatewayClient] - 真实模式唯一可调用的 GatewayClient。
 * @returns {Promise<RuntimeRoutingAssembly>} 可逐轮执行并提取事实的场景装配。
 */
export async function createRuntimeRoutingScenarioAssembly({
  scenario,
  mode,
  workingDirectory,
  realClassifierGatewayClient,
}) {
  assertRoutingMode(mode);
  assertClassifierPromptVersion(scenario.definition.classifier.promptVersion);
  if (mode === "real-model" && !realClassifierGatewayClient) {
    throw new TypeError("real-model mode requires a classifier GatewayClient");
  }

  const store = createConversationStore({
    databasePath: join(workingDirectory, "conversation.sqlite"),
  });
  const imageAssetStore = createLocalImageAssetStore({
    directory: join(workingDirectory, "image-assets"),
  });
  const controller = createRoutingFixtureController(scenario);
  const facade = createRoutingGatewayFacade({
    mode,
    controller,
    realClassifierGatewayClient,
  });
  const contextPlanner = createContextPlanner({
    store,
    gatewayClient: facade.gatewayClient,
    contextOptions: DEFAULT_CONTEXT_OPTIONS,
    systemPrompt: "你是 Runtime 路由链路评测中的固定业务回复后端。",
  });
  const memoryManager = createMemoryManager({
    store,
    gatewayClient: facade.gatewayClient,
    contextOptions: DEFAULT_CONTEXT_OPTIONS,
    onError: ignoreBackgroundMemoryError,
  });
  const intentRouter = createRunIntentRouter({
    gatewayClient: facade.gatewayClient,
    confidenceThreshold: scenario.definition.classifier.confidenceThreshold,
    maxCompletionTokens: scenario.definition.classifier.maxCompletionTokens,
  });
  const runtime = createChatRuntime({
    gatewayClient: facade.gatewayClient,
    contextOptions: DEFAULT_CONTEXT_OPTIONS,
    store,
    coordinator: createConversationCoordinator(),
    contextPlanner,
    memoryManager,
    imageAssetStore,
    intentRouter,
    resilienceOptions: { runTimeoutMs: scenario.definition.runtime.runTimeoutMs },
  });

  return {
    runtime,
    store,
    controller,
    observations: facade.observations,
    /** 关闭 SQLite；临时目录的删除由 Suite 按 keepArtifacts 策略统一处理。 */
    async close() {
      store.close();
    },
  };
}

/**
 * 运行版本化 Runtime 路由场景，并输出不含正文、图片 ID 或 provider 原始响应的报告。
 *
 * @param {object} input - Suite 范围和模式参数。
 * @param {string} input.rootDir - 项目根目录。
 * @param {"deterministic"|"real-model"} input.mode - 分类器执行模式。
 * @param {string[]} [input.scenarioIds] - 可选场景白名单。
 * @param {string} [input.modelAlias] - 真实模式必须显式固定的模型别名。
 * @param {boolean} [input.keepArtifacts=false] - 是否保留临时 SQLite 与图片文件。
 * @param {object} [dependencies] - 测试可替换依赖。
 * @param {(input: object) => Promise<object>} [dependencies.createRealClassifierGateway] - 真实分类 Gateway 工厂。
 * @returns {Promise<object>} runtime-routing-report.v1 报告。
 */
export async function runRuntimeRoutingScenarioSuite(
  {
    rootDir,
    mode,
    scenarioIds = [],
    modelAlias,
    keepArtifacts = false,
  },
  { createRealClassifierGateway = createDefaultRealClassifierGateway } = {},
) {
  assertRoutingMode(mode);
  assertRealModelAlias(mode, modelAlias);
  const startedAt = new Date().toISOString();
  const suiteStarted = performance.now();
  const scenariosRoot = join(rootDir, "scenarios", "runtime-routing");
  const directories = await discoverRuntimeRoutingScenarioDirectories(scenariosRoot);
  const selectedIds = new Set(scenarioIds);
  const discoveredIds = new Set();
  const results = [];

  for (const directory of directories) {
    const scenario = await loadRuntimeRoutingScenario(directory);
    discoveredIds.add(scenario.definition.id);
    if (selectedIds.size > 0 && !selectedIds.has(scenario.definition.id)) continue;
    if (!scenario.definition.supportedModes.includes(mode)) {
      results.push(buildSkippedScenarioResult(scenario, mode));
      continue;
    }
    const realClassifierGatewayClient = mode === "real-model"
      ? await createRealClassifierGateway({ rootDir, modelAlias })
      : null;
    results.push(await runRoutingScenario({
      scenario,
      mode,
      realClassifierGatewayClient,
      keepArtifacts,
    }));
  }

  assertSelectedScenariosExist(selectedIds, discoveredIds);
  return buildSuiteReport({
    mode,
    modelAlias,
    startedAt,
    durationMs: performance.now() - suiteStarted,
    scenarios: results,
  });
}

/** 将路由评测报告原子需求收敛为格式化 JSON 文件，并返回绝对路径。 */
export async function writeRuntimeRoutingScenarioReport(report, reportPath) {
  const target = resolve(reportPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return target;
}

/**
 * 按真实有效分类样本数决定结论等级；总轮次、固定后端调用和失败分类不得充当分母。
 *
 * @param {object} input - 当前模式与通过动态 schema 的唯一轮次样本数。
 * @param {"deterministic"|"real-model"} input.mode - 当前评测模式。
 * @param {number} input.validClassifierSampleCount - 最终分类调用有效的唯一轮次数。
 * @returns {"observation-only"|"regression-gate"} 报告结论策略。
 */
export function resolveRuntimeRoutingConclusionPolicy({ mode, validClassifierSampleCount }) {
  assertRoutingMode(mode);
  if (!Number.isInteger(validClassifierSampleCount) || validClassifierSampleCount < 0) {
    throw new TypeError("valid classifier sample count must be a non-negative integer");
  }
  return mode === "real-model" && validClassifierSampleCount < REPORT_SAMPLE_GATE
    ? "observation-only"
    : "regression-gate";
}

/** 执行一个场景的全部独立会话，确保 gold 只在 Run 完成后参与判定。 */
async function runRoutingScenario({
  scenario,
  mode,
  realClassifierGatewayClient,
  keepArtifacts,
}) {
  const started = performance.now();
  const workingDirectory = await mkdtemp(join(tmpdir(), `ai-platform-routing-${scenario.definition.id}-`));
  let assembly;
  try {
    assembly = await createRuntimeRoutingScenarioAssembly({
      scenario,
      mode,
      workingDirectory,
      realClassifierGatewayClient,
    });
    const turns = [];
    for (const conversation of scenario.definition.conversations) {
      const conversationTurns = await runRoutingConversation({
        scenario,
        conversation,
        assembly,
      });
      turns.push(...conversationTurns);
    }
    const metrics = calculateRoutingMetrics(turns);
    const checks = buildRoutingChecks(metrics, scenario.gold.thresholds);
    return {
      id: scenario.definition.id,
      fixtureVersion: scenario.definition.version,
      mode,
      status: checks.every(readCheckPassed) ? "passed" : "failed",
      classifierConfiguration: buildClassifierConfiguration(scenario),
      durationMs: roundMilliseconds(performance.now() - started),
      temporaryArtifactsKept: Boolean(keepArtifacts),
      ...(keepArtifacts ? { workingDirectory } : {}),
      metrics,
      checks,
      usage: aggregateClassifierUsage(turns),
      latency: {
        routing: summarizeLatency(readClassifierDurations(turns)),
        endToEnd: summarizeLatency(readRunDurations(turns)),
      },
      classifier: summarizeClassifierCalls(turns),
      backend: {
        chatCalls: assembly.observations.chatCalls.length,
        imageGenerationCalls: assembly.observations.imageGenerationCalls.length,
        imageEditCalls: assembly.observations.imageEditCalls.length,
      },
      turns,
    };
  } catch (error) {
    return buildFailedScenarioResult(scenario, mode, error, performance.now() - started, keepArtifacts, workingDirectory);
  } finally {
    if (assembly) await assembly.close();
    if (!keepArtifacts) await rm(workingDirectory, { recursive: true, force: true });
  }
}

/** 依次执行同一会话轮次，并维护逻辑 fixture 到真实消息和资产事实的映射。 */
async function runRoutingConversation({ scenario, conversation, assembly }) {
  const created = assembly.runtime.createConversation({ title: conversation.title });
  const assetTargets = new Map();
  const assetFingerprints = new Map();
  const messageTargets = new Map();
  const messageFacts = new Map();
  const turnResults = [];

  for (const asset of conversation.assets) {
    const bytes = Buffer.from(asset.base64, "base64");
    const uploaded = await assembly.runtime.uploadImageAsset(created.id, {
      bytes,
      mediaType: asset.mediaType,
    });
    assetTargets.set(toFixtureAssetKey(asset.id), uploaded.assetId);
    assetFingerprints.set(uploaded.assetId, fingerprintImageInput({
      bytes,
      mediaType: asset.mediaType,
    }));
  }

  for (const turn of conversation.turns) {
    const priorMessageTargets = new Map(messageTargets);
    const priorMessageFacts = new Map(messageFacts);
    const priorMessageIds = new Set(messageTargets.values());
    assembly.controller.selectTurn({
      conversationId: conversation.id,
      turnId: turn.id,
      resolveMessageReference: createMessageReferenceResolver(messageTargets),
    });
    const input = materializeRunInput(turn.input, assetTargets);
    const classifierCallOffset = assembly.observations.classifierCalls.length;
    const backendCallOffsets = captureBackendCallOffsets(assembly.observations);
    const turnStarted = performance.now();
    try {
      const result = await assembly.runtime.runConversation(created.id, input);
      const runDurationMs = performance.now() - turnStarted;
      const persisted = assembly.store.findRunByRequestId(created.id, input.requestId);
      registerTurnFacts({
        turn,
        persisted,
        assetTargets,
        assetFingerprints,
        messageTargets,
        messageFacts,
      });
      const detail = assembly.runtime.getConversation(created.id);
      const classifierCalls = assembly.observations.classifierCalls.slice(classifierCallOffset);
      const backendCalls = readBackendCalls(assembly.observations, backendCallOffsets);
      const gold = findTurnEntry(scenario.gold.turns, conversation.id, turn.id, "gold");
      const requiredEvidenceIds = resolveRequiredEvidenceIds(gold, priorMessageTargets);
      const requiredPromptHistory = resolveRequiredPromptHistory(gold, priorMessageFacts);
      turnResults.push(evaluateCompletedTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        gold,
        result,
        persisted,
        detail,
        assetTargets,
        assetFingerprints,
        priorMessageIds,
        priorMessageFacts,
        requiredEvidenceIds,
        requiredPromptHistory,
        classifierCalls,
        backendCalls,
        runDurationMs,
      }));
    } catch (error) {
      const classifierCalls = assembly.observations.classifierCalls.slice(classifierCallOffset);
      const backendCalls = readBackendCalls(assembly.observations, backendCallOffsets);
      const gold = findTurnEntry(scenario.gold.turns, conversation.id, turn.id, "gold");
      turnResults.push(buildFailedTurnResult({
        conversationId: conversation.id,
        turnId: turn.id,
        gold,
        classifierCalls,
        backendCalls,
        runDurationMs: performance.now() - turnStarted,
        error,
      }));
    }
  }
  return turnResults;
}

/** 把 case 中的逻辑资产引用替换为当前临时会话的真实受控资产 ID。 */
function materializeRunInput(input, assetTargets) {
  const references = [];
  for (const reference of input.references) {
    references.push({
      type: reference.type,
      assetId: resolveAssetTarget(reference.source, assetTargets),
    });
  }
  return {
    ...input,
    references,
  };
}

/** 在 Run 完成后登记当前轮的用户消息、助手消息和图片产物逻辑键。 */
function registerTurnFacts({
  turn,
  persisted,
  assetTargets,
  assetFingerprints,
  messageTargets,
  messageFacts,
}) {
  if (!persisted) throw new Error(`missing persisted run: ${turn.id}`);
  if (persisted.userMessage?.id) {
    const key = toMessageTargetKey(turn.id, "user");
    messageTargets.set(key, persisted.userMessage.id);
    messageFacts.set(key, toMessageFact(persisted.userMessage));
  }
  if (persisted.assistantMessage?.id) {
    const key = toMessageTargetKey(turn.id, "assistant");
    messageTargets.set(key, persisted.assistantMessage.id);
    messageFacts.set(key, toMessageFact(persisted.assistantMessage));
  }
  let index = 0;
  for (const artifact of persisted.artifacts || []) {
    assetTargets.set(toTurnArtifactKey(turn.id, index), artifact.assetId);
    assetFingerprints.set(artifact.assetId, fingerprintPersistedArtifact(artifact));
    index += 1;
  }
}

/** 将已提交消息收敛为解析隐藏 Prompt 历史所需的不可变事实。 */
function toMessageFact(message) {
  return Object.freeze({
    id: String(message.id),
    role: message.role === "assistant" ? "assistant" : "user",
    displayContent: String(message.displayContent || ""),
  });
}

/** 将已提交图片产物收敛为不含资产 ID 或字节的稳定指纹。 */
function fingerprintPersistedArtifact(artifact) {
  const sha256 = String(artifact?.sha256 || "").trim();
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("persisted routing fixture artifact is missing sha256");
  }
  return Object.freeze({
    sha256,
    mediaType: String(artifact?.mediaType || ""),
    sizeBytes: Number(artifact?.sizeBytes) || 0,
  });
}

/** 读取逻辑目标对应的预期图片指纹，缺失表示评测装配事实不完整。 */
function readExpectedAssetFingerprint(assetId, assetFingerprints) {
  const fingerprint = assetFingerprints.get(assetId);
  if (!fingerprint) throw new Error("expected routing fixture asset fingerprint is unavailable");
  return fingerprint;
}

/** 记录当前轮开始时各固定业务后端的调用游标。 */
function captureBackendCallOffsets(observations) {
  return Object.freeze({
    chat: observations.chatCalls.length,
    imageGeneration: observations.imageGenerationCalls.length,
    imageEdit: observations.imageEditCalls.length,
  });
}

/** 从调用游标提取当前轮真实发生的业务后端调用。 */
function readBackendCalls(observations, offsets) {
  return Object.freeze({
    chatCalls: observations.chatCalls.slice(offsets.chat),
    imageGenerationCalls: observations.imageGenerationCalls.slice(offsets.imageGeneration),
    imageEditCalls: observations.imageEditCalls.slice(offsets.imageEdit),
  });
}

/** 使用隐藏 gold 对已提交 Store 事实作判定，不把答案暴露给路由器或业务后端。 */
function evaluateCompletedTurn({
  conversationId,
  turnId,
  gold,
  result,
  persisted,
  detail,
  assetTargets,
  assetFingerprints,
  priorMessageIds,
  priorMessageFacts,
  requiredEvidenceIds,
  requiredPromptHistory,
  classifierCalls,
  backendCalls,
  runDurationMs,
}) {
  const decision = persisted.run.intentDecision || {};
  const evidenceIds = Array.isArray(decision.relevantMessageIds)
    ? decision.relevantMessageIds
    : [];
  const actualSourceAssetId = readRunSourceImageAssetId(persisted);
  const expectedSourceAssetId = gold.editSource
    ? resolveAssetTarget(gold.editSource, assetTargets)
    : null;
  const expectedSourceFingerprint = expectedSourceAssetId
    ? readExpectedAssetFingerprint(expectedSourceAssetId, assetFingerprints)
    : null;
  const expectedVisionAssetId = gold.visionSource
    ? resolveAssetTarget(gold.visionSource, assetTargets)
    : null;
  const expectedVisionFingerprint = expectedVisionAssetId
    ? readExpectedAssetFingerprint(expectedVisionAssetId, assetFingerprints)
    : null;
  const expectedActiveAssetId = gold.activeImage
    ? resolveAssetTarget(gold.activeImage, assetTargets)
    : null;
  const actualActiveAssetId = detail.workingContext?.activeImage?.assetId || null;
  const evidenceValid = validateEvidence({
    evidenceIds,
    priorMessageIds,
    minimumCount: gold.evidence.minimumCount,
    requiredEvidenceIds,
  });
  const routedPromptHistory = resolveRoutedPromptHistory(evidenceIds, priorMessageFacts);
  const promptHistory = mergeMessageFacts(requiredPromptHistory, routedPromptHistory);
  const actualArtifactCount = Array.isArray(result.artifacts) ? result.artifacts.length : 0;
  const sourceReferenceCorrect = gold.editSource
    ? actualSourceAssetId === expectedSourceAssetId
    : null;
  const sourceBytesCorrect = gold.editSource
    ? validateEditSourceBytes(backendCalls.imageEditCalls, expectedSourceFingerprint)
    : null;
  const visualInputEvaluated = gold.operation === "conversation.chat";
  const visualInputCorrect = visualInputEvaluated
    ? validateVisualChatInput(backendCalls.chatCalls, expectedVisionFingerprint)
    : null;
  const editPromptHistoryEvaluated = gold.operation === "image.edit" && promptHistory.length > 0;
  const editPromptHistoryCorrect = editPromptHistoryEvaluated
    ? validateEditPromptHistory(backendCalls.imageEditCalls, promptHistory)
    : null;
  const backendEvidence = summarizeTurnBackendCalls(backendCalls);

  return {
    conversationId,
    turnId,
    status: "completed",
    expectedOperation: gold.operation,
    actualOperation: result.operation,
    operationCorrect: result.operation === gold.operation,
    candidateSetCorrect: equalStringArrays(decision.candidates, gold.candidates),
    useActiveImageCorrect: Boolean(decision.useActiveImage) === gold.useActiveImage,
    sourceImageEvaluated: Boolean(gold.editSource),
    sourceImageCorrect: gold.editSource
      ? Boolean(sourceReferenceCorrect && sourceBytesCorrect)
      : null,
    sourceReferenceCorrect,
    sourceBytesCorrect,
    visualInputEvaluated,
    visualInputCorrect,
    editPromptHistoryEvaluated,
    editPromptHistoryCorrect,
    requiredPromptHistoryCount: requiredPromptHistory.length,
    routedPromptHistoryCount: routedPromptHistory.length,
    evidenceValid,
    evidenceCount: evidenceIds.length,
    activeImageCorrect: actualActiveAssetId === expectedActiveAssetId,
    artifactCountCorrect: actualArtifactCount === gold.artifactCount,
    expectedArtifactCount: gold.artifactCount,
    actualArtifactCount,
    actualImageCallCount: backendEvidence.imageCallCount,
    wrongImageSideEffect: gold.artifactCount === 0 && backendEvidence.imageCallCount > 0,
    decision: {
      schemaVersion: decision.schemaVersion || null,
      routerVersion: decision.routerVersion || null,
      contextStrategyVersion: decision.contextStrategyVersion || null,
      source: decision.source || null,
      classifiedOperation: decision.classifiedOperation || null,
      confidence: finiteNumberOrNull(decision.confidence),
      candidates: Array.isArray(decision.candidates) ? [...decision.candidates] : [],
      useActiveImage: Boolean(decision.useActiveImage),
      evidenceCount: evidenceIds.length,
    },
    classifier: sanitizeClassifierCall(classifierCalls.at(-1) || null),
    classifierCalls: classifierCalls.map(sanitizeClassifierCall),
    backendEvidence,
    runDurationMs: roundMilliseconds(runDurationMs),
  };
}

/** 在当前轮执行前把 gold 的逻辑历史证据解析为真实 Store 消息 ID。 */
function resolveRequiredEvidenceIds(gold, messageTargets) {
  const ids = [];
  for (const reference of gold.evidence.requiredAnyOf) {
    const id = messageTargets.get(toMessageTargetKey(reference.turnId, reference.role));
    if (!id) throw new Error(`gold evidence target is unavailable: ${reference.turnId}/${reference.role}`);
    ids.push(id);
  }
  return ids;
}

/** 把 gold 的逻辑 Prompt 历史引用解析为运行前已提交消息事实。 */
function resolveRequiredPromptHistory(gold, messageFacts) {
  const facts = [];
  for (const reference of gold.editPromptHistory.requiredAll) {
    const fact = messageFacts.get(toMessageTargetKey(reference.turnId, reference.role));
    if (!fact) {
      throw new Error(`gold prompt history target is unavailable: ${reference.turnId}/${reference.role}`);
    }
    facts.push(fact);
  }
  return facts;
}

/** 按已验证路由证据 ID 解析图片编辑模型实际应继承的全部历史消息。 */
function resolveRoutedPromptHistory(evidenceIds, messageFacts) {
  const factsById = new Map();
  for (const fact of messageFacts.values()) factsById.set(fact.id, fact);
  const facts = [];
  for (const id of evidenceIds) {
    const fact = factsById.get(id);
    if (!fact) throw new Error("routed prompt history target is unavailable");
    facts.push(fact);
  }
  return facts;
}

/** 合并 gold 必须历史与 Router 实际证据，并按消息 ID 去重。 */
function mergeMessageFacts(requiredFacts, routedFacts) {
  const merged = [];
  const seen = new Set();
  for (const fact of [...requiredFacts, ...routedFacts]) {
    if (seen.has(fact.id)) continue;
    seen.add(fact.id);
    merged.push(fact);
  }
  return merged;
}

/** 从持久化用户消息中读取图片编辑实际使用的首个受控图片引用。 */
function readRunSourceImageAssetId(persisted) {
  for (const reference of persisted.userMessage?.references || []) {
    if (reference?.type === "image_asset" && reference.assetId) return reference.assetId;
  }
  return null;
}

/** 验证图片编辑后端恰好收到一张与 gold 逻辑源资产相同的图片字节。 */
function validateEditSourceBytes(imageEditCalls, expectedFingerprint) {
  if (!expectedFingerprint || imageEditCalls.length !== 1) return false;
  const sourceImages = imageEditCalls[0].sourceImages;
  return sourceImages.length === 1 && equalImageFingerprints(sourceImages[0], expectedFingerprint);
}

/** 验证普通生成回答的最新用户消息是否携带 gold 声明的视觉输入。 */
function validateVisualChatInput(chatCalls, expectedFingerprint) {
  const generationCalls = [];
  for (const call of chatCalls) {
    if (call.operation === "model.generate") generationCalls.push(call);
  }
  if (generationCalls.length !== 1) return false;
  const images = generationCalls[0].latestUserImages;
  if (!expectedFingerprint) return images.length === 0;
  return images.length === 1 && equalImageFingerprints(images[0], expectedFingerprint);
}

/** 验证编辑模型收到的 Prompt 含全部 gold 历史消息及其原始角色。 */
function validateEditPromptHistory(imageEditCalls, requiredHistory) {
  if (imageEditCalls.length !== 1) return false;
  const prompt = normalizePromptText(imageEditCalls[0].prompt);
  for (const fact of requiredHistory) {
    const role = fact.role === "assistant" ? "助手" : "用户";
    const expectedLine = normalizePromptText(`${role}：${fact.displayContent}`);
    if (!expectedLine || !prompt.includes(expectedLine)) return false;
  }
  return true;
}

/** 将图片指纹按哈希、媒体类型和字节数作完整比较。 */
function equalImageFingerprints(actual, expected) {
  return Boolean(
    actual
    && expected
    && actual.sha256 === expected.sha256
    && actual.mediaType === expected.mediaType
    && actual.sizeBytes === expected.sizeBytes,
  );
}

/** 将 Prompt 文本的空白收敛为与 Runtime 图片编辑协议一致的单行比较形式。 */
function normalizePromptText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

/** 将当前轮后端调用收敛为可落报告的数量、状态与哈希证据。 */
function summarizeTurnBackendCalls(backendCalls) {
  const chatImageSha256s = [];
  const imageEditSourceSha256s = [];
  const editPromptSha256s = [];
  let chatImageCount = 0;
  let imageEditSourceCount = 0;
  let failedImageCallCount = 0;
  for (const call of backendCalls.chatCalls) {
    for (const image of call.latestUserImages) {
      chatImageCount += 1;
      if (image.sha256) chatImageSha256s.push(image.sha256);
    }
  }
  for (const call of backendCalls.imageEditCalls) {
    if (call.status === "failed") failedImageCallCount += 1;
    for (const image of call.sourceImages) {
      imageEditSourceCount += 1;
      if (image.sha256) imageEditSourceSha256s.push(image.sha256);
    }
    editPromptSha256s.push(hashUtf8(call.prompt));
  }
  for (const call of backendCalls.imageGenerationCalls) {
    if (call.status === "failed") failedImageCallCount += 1;
  }
  return {
    chatCallCount: backendCalls.chatCalls.length,
    imageGenerationCallCount: backendCalls.imageGenerationCalls.length,
    imageEditCallCount: backendCalls.imageEditCalls.length,
    imageCallCount: backendCalls.imageGenerationCalls.length + backendCalls.imageEditCalls.length,
    failedImageCallCount,
    chatImageCount,
    imageEditSourceCount,
    chatImageSha256s,
    imageEditSourceSha256s,
    editPromptSha256s,
  };
}

/** 验证证据均来自严格历史、数量达标且命中 gold 声明的任一必要来源。 */
function validateEvidence({ evidenceIds, priorMessageIds, minimumCount, requiredEvidenceIds }) {
  const unique = new Set(evidenceIds);
  if (unique.size !== evidenceIds.length || evidenceIds.length < minimumCount) return false;
  for (const id of evidenceIds) {
    if (!priorMessageIds.has(id)) return false;
  }
  if (requiredEvidenceIds.length === 0) return true;
  for (const id of requiredEvidenceIds) {
    if (unique.has(id)) return true;
  }
  return false;
}

/** 把单轮异常收敛为安全错误分类，不保存模型或存储原始错误正文。 */
function buildFailedTurnResult({
  conversationId,
  turnId,
  gold,
  classifierCalls,
  backendCalls,
  runDurationMs,
  error,
}) {
  const backendEvidence = summarizeTurnBackendCalls(backendCalls);
  return {
    conversationId,
    turnId,
    status: "failed",
    expectedOperation: gold.operation,
    actualOperation: null,
    operationCorrect: false,
    candidateSetCorrect: false,
    useActiveImageCorrect: false,
    sourceImageEvaluated: Boolean(gold.editSource),
    sourceImageCorrect: gold.editSource ? false : null,
    sourceReferenceCorrect: gold.editSource ? false : null,
    sourceBytesCorrect: gold.editSource ? false : null,
    visualInputEvaluated: gold.operation === "conversation.chat",
    visualInputCorrect: false,
    editPromptHistoryEvaluated: gold.editPromptHistory.requiredAll.length > 0,
    editPromptHistoryCorrect: gold.editPromptHistory.requiredAll.length > 0 ? false : null,
    requiredPromptHistoryCount: gold.editPromptHistory.requiredAll.length,
    evidenceValid: false,
    evidenceCount: 0,
    activeImageCorrect: false,
    artifactCountCorrect: false,
    expectedArtifactCount: gold.artifactCount,
    actualArtifactCount: 0,
    actualImageCallCount: backendEvidence.imageCallCount,
    wrongImageSideEffect: gold.artifactCount === 0 && backendEvidence.imageCallCount > 0,
    errorCode: readSafeErrorCode(error),
    classifier: sanitizeClassifierCall(classifierCalls.at(-1) || null),
    classifierCalls: classifierCalls.map(sanitizeClassifierCall),
    backendEvidence,
    runDurationMs: roundMilliseconds(runDurationMs),
  };
}

/** 创建只以显式当前轮次为索引的 sidecar 控制器，禁止按用户关键词分支。 */
function createRoutingFixtureController(scenario) {
  const classifierTurns = indexTurnEntries(scenario.modelFixture.classifierTurns);
  const chatTurns = indexTurnEntries(scenario.modelFixture.chatTurns);
  const imageTurns = indexTurnEntries(scenario.modelFixture.imageTurns);
  let current = null;

  return {
    /** 由 Runner 在每轮开始前声明逻辑身份和历史消息解析 Port。 */
    selectTurn({ conversationId, turnId, resolveMessageReference }) {
      current = Object.freeze({ conversationId, turnId, resolveMessageReference });
    },
    /** 读取当前轮固定分类输出，并把逻辑证据引用替换为真实历史消息 ID。 */
    readClassifierOutput() {
      const entry = readCurrentFixtureEntry(classifierTurns, current, "classifier fixture");
      const relevantMessageIds = [];
      for (const reference of entry.output.relevantMessages) {
        relevantMessageIds.push(current.resolveMessageReference(reference));
      }
      return {
        operation: entry.output.operation,
        confidence: entry.output.confidence,
        useActiveImage: entry.output.useActiveImage,
        relevantMessageIds,
      };
    },
    /** 读取当前轮固定业务文本，图片轮只会在异常情况下使用该兜底。 */
    readChatContent() {
      return readCurrentFixtureEntry(chatTurns, current, "chat fixture").content;
    },
    /** 读取当前轮图片后端行为，并拒绝调用与 sidecar 声明不一致的图片能力。 */
    readImageBehavior(operation) {
      const entry = readCurrentFixtureEntry(imageTurns, current, "image fixture");
      if (entry.operation !== operation) {
        throw createFixtureGatewayError("fixture_image_operation_mismatch");
      }
      return entry.behavior;
    },
    /** 返回当前轮稳定键，供旁路分类记录关联而不保存正文。 */
    readTurnKey() {
      return current ? toTurnKey(current.conversationId, current.turnId) : null;
    },
  };
}

/** 创建 Gateway Facade：分类端按模式切换，其余业务模型能力始终固定。 */
function createRoutingGatewayFacade({ mode, controller, realClassifierGatewayClient }) {
  const observations = {
    classifierCalls: [],
    chatCalls: [],
    imageGenerationCalls: [],
    imageEditCalls: [],
  };

  /** 执行并记录唯一允许切换为真实模型的结构化分类调用。 */
  async function classify(input) {
    const started = performance.now();
    try {
      const result = mode === "deterministic"
        ? createDeterministicClassifierResult(input, controller.readClassifierOutput())
        : await realClassifierGatewayClient.chatCompletions(input);
      observations.classifierCalls.push({
        turnKey: controller.readTurnKey(),
        status: "completed",
        durationMs: performance.now() - started,
        model: String(result?.model || "").trim() || null,
        usage: normalizeUsage(result?.usage),
        outputValid: validateClassifierOutput(input, result),
      });
      return result;
    } catch (error) {
      observations.classifierCalls.push({
        turnKey: controller.readTurnKey(),
        status: "failed",
        durationMs: performance.now() - started,
        model: null,
        usage: null,
        outputValid: false,
        errorCode: readSafeErrorCode(error),
      });
      throw error;
    }
  }

  const gatewayClient = {
    model: FIXED_CHAT_MODEL,
    imageModel: FIXED_IMAGE_MODEL,
    imageEditModel: FIXED_IMAGE_MODEL,
    defaultModels: {
      "conversation.chat": FIXED_CHAT_MODEL,
      "image.generate": FIXED_IMAGE_MODEL,
      "image.edit": FIXED_IMAGE_MODEL,
    },
    /** Context Planner 始终使用本地估算，不让真实分类模式扩大模型调用范围。 */
    async countTokens({ messages }) {
      return {
        tokens: estimateMessagesTokens(messages),
        source: "runtime-routing-fixture",
        model: FIXED_CHAT_MODEL,
      };
    },
    /** Runtime 文本模型解析固定落到 fixture 别名，不访问 LiteLLM 模型目录。 */
    async resolveConversationModel() {
      return FIXED_CHAT_MODEL;
    },
    /** Runtime 图片模型解析固定落到 fixture 别名，不访问真实图片上游。 */
    async resolveImageModel() {
      return FIXED_IMAGE_MODEL;
    },
    /** 仅 `model.intent.classify` 可进入分类器；普通聊天始终返回当前轮固定文本。 */
    async chatCompletions(input) {
      if (input.operation === "model.intent.classify") return classify(input);
      observations.chatCalls.push({
        turnKey: controller.readTurnKey(),
        operation: String(input.operation || "model.generate"),
        latestUserImages: fingerprintLatestUserImages(input.messages),
      });
      return {
        model: FIXED_CHAT_MODEL,
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        choices: [{ message: { role: "assistant", content: controller.readChatContent() } }],
      };
    },
    /** 按当前轮 sidecar 返回固定图片或失败，并在任何校验前记录真实调用。 */
    async generateImages({ prompt } = {}) {
      const call = {
        turnKey: controller.readTurnKey(),
        status: "started",
        prompt: String(prompt || ""),
      };
      observations.imageGenerationCalls.push(call);
      return executeFixtureImageCall({
        call,
        operation: "image.generate",
        resilienceOperation: "model.image.generate",
        controller,
      });
    },
    /** 按当前轮 sidecar 返回固定编辑结果，并记录实际 Prompt 与源图字节指纹。 */
    async editImages({ prompt, sourceImages } = {}) {
      const call = {
        turnKey: controller.readTurnKey(),
        status: "started",
        prompt: String(prompt || ""),
        sourceImages: fingerprintImageInputs(sourceImages),
      };
      observations.imageEditCalls.push(call);
      if (!Array.isArray(sourceImages) || sourceImages.length !== 1) {
        call.status = "failed";
        call.errorCode = "fixture_image_source_count_invalid";
        throw createFixtureGatewayError(call.errorCode);
      }
      return executeFixtureImageCall({
        call,
        operation: "image.edit",
        resilienceOperation: "model.image.edit",
        controller,
      });
    },
  };
  return { gatewayClient, observations };
}

/** 构造固定分类响应，并用请求规模生成可复现 token 证据。 */
function createDeterministicClassifierResult(input, output) {
  const promptTokens = Math.max(1, estimateMessagesTokens(input.messages || []));
  const completionTokens = Math.max(1, Math.ceil(JSON.stringify(output).length / 4));
  return {
    model: FIXED_CLASSIFIER_MODEL,
    output,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/** 复用 Router 的本轮动态 Zod schema 判定分类响应是否构成有效质量样本。 */
function validateClassifierOutput(input, result) {
  const schema = input?.outputSchema?.schema;
  if (!schema || typeof schema.safeParse !== "function") return false;
  return schema.safeParse(result?.output).success;
}

/** 执行当前轮图片 sidecar 行为，并把完成或失败状态写回旁路调用证据。 */
function executeFixtureImageCall({ call, operation, resilienceOperation, controller }) {
  try {
    const behavior = controller.readImageBehavior(operation);
    if (behavior.status === "failed") {
      throw createFixtureGatewayError(behavior.errorCode);
    }
    const result = createFixtureImageResult(resilienceOperation, behavior.image);
    call.status = "completed";
    return result;
  } catch (error) {
    call.status = "failed";
    call.errorCode = readSafeErrorCode(error);
    throw error;
  }
}

/** 创建只携带稳定错误码的固定图片 Gateway 异常。 */
function createFixtureGatewayError(code) {
  const error = new Error("runtime routing fixture gateway failed");
  error.code = String(code || "fixture_image_gateway_failed");
  return error;
}

/** 对一组图片输入逐一计算不含原始字节的稳定内容指纹。 */
function fingerprintImageInputs(images) {
  const fingerprints = [];
  for (const image of Array.isArray(images) ? images : []) {
    fingerprints.push(fingerprintImageInput(image));
  }
  return fingerprints;
}

/** 对受控图片输入计算 SHA-256、媒体类型和字节长度。 */
function fingerprintImageInput(image) {
  const bytes = toImageBuffer(image?.bytes);
  return Object.freeze({
    sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
    mediaType: String(image?.mediaType || ""),
    sizeBytes: bytes ? bytes.length : 0,
  });
}

/** 从普通聊天请求的最新用户消息提取实际发送的图片数据指纹。 */
function fingerprintLatestUserImages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role !== "user") continue;
    return fingerprintMessageImages(message.content);
  }
  return [];
}

/** 从 OpenAI-compatible 多模态 content 中提取 data URL 图片指纹。 */
function fingerprintMessageImages(content) {
  const fingerprints = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type !== "image_url") continue;
    fingerprints.push(fingerprintImageUrl(part?.image_url?.url));
  }
  return fingerprints;
}

/** 解析图片 data URL；远程或非法地址保留不可匹配占位事实。 */
function fingerprintImageUrl(value) {
  const match = /^data:([^;,]+);base64,(.+)$/isu.exec(String(value || ""));
  if (!match) return Object.freeze({ sha256: null, mediaType: "", sizeBytes: 0 });
  const bytes = Buffer.from(match[2], "base64");
  return fingerprintImageInput({ bytes, mediaType: match[1] });
}

/** 将 Buffer 或 Uint8Array 图片输入收敛为 Buffer，其他类型视为无效。 */
function toImageBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

/** 对不含密钥的内部 Prompt 计算报告用 SHA-256，不保留正文。 */
function hashUtf8(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

/** 构造符合 Runtime 图片检查和韧性契约的固定单图结果。 */
function createFixtureImageResult(operation, image) {
  return {
    model: FIXED_IMAGE_MODEL,
    images: [{ bytes: Buffer.from(image.base64, "base64"), mediaType: image.mediaType }],
    usage: { input_tokens: null, output_tokens: null, total_tokens: null, generated_images: 1 },
    resilience: {
      operation,
      maxAttempts: 1,
      attemptCount: 1,
      retryBoundaryCrossed: true,
      attempts: [{ attempt: 1, status: "completed", willRetry: false }],
    },
  };
}

/** 使用 Demo 服务端配置创建真实分类 Gateway；密钥只保留在配置对象内且不进入报告。 */
async function createDefaultRealClassifierGateway({ rootDir, modelAlias }) {
  const config = await loadDemoConfig(rootDir);
  const alias = String(modelAlias || "").trim();
  return createGatewayClient({
    ...config.gateway,
    model: alias,
    modelCapabilities: {
      ...config.gateway.modelCapabilities,
      chat: [alias],
    },
  });
}

/** 聚合单场景全部轮次的六项核心指标及辅助链路不变量。 */
function calculateRoutingMetrics(turns) {
  const sourceTurns = [];
  const visualInputTurns = [];
  const editPromptHistoryTurns = [];
  const noImageSideEffectTurns = [];
  for (const turn of turns) {
    if (turn.sourceImageEvaluated) sourceTurns.push(turn);
    if (turn.visualInputEvaluated) visualInputTurns.push(turn);
    if (turn.editPromptHistoryEvaluated) editPromptHistoryTurns.push(turn);
    if (turn.expectedArtifactCount === 0) noImageSideEffectTurns.push(turn);
  }
  return {
    sampleCount: turns.length,
    operationAccuracy: calculateBooleanRate(turns, "operationCorrect"),
    sourceImageAccuracy: calculateBooleanRate(sourceTurns, "sourceImageCorrect"),
    sourceReferenceAccuracy: calculateBooleanRate(sourceTurns, "sourceReferenceCorrect"),
    sourceBytesAccuracy: calculateBooleanRate(sourceTurns, "sourceBytesCorrect"),
    visualInputAccuracy: calculateBooleanRate(visualInputTurns, "visualInputCorrect"),
    editPromptHistoryAccuracy: calculateBooleanRate(
      editPromptHistoryTurns,
      "editPromptHistoryCorrect",
    ),
    evidenceValidity: calculateBooleanRate(turns, "evidenceValid"),
    activeImageAccuracy: calculateBooleanRate(turns, "activeImageCorrect"),
    wrongImageSideEffectRate: calculateOccurrenceRate(
      noImageSideEffectTurns,
      "wrongImageSideEffect",
    ),
    candidateSetAccuracy: calculateBooleanRate(turns, "candidateSetCorrect"),
    useActiveImageAccuracy: calculateBooleanRate(turns, "useActiveImageCorrect"),
    artifactCountAccuracy: calculateBooleanRate(turns, "artifactCountCorrect"),
    executionErrorCount: countTurnsByStatus(turns, "failed"),
  };
}

/** 将场景 gold 阈值和 Runtime 固有不变量转换为可扫描检查。 */
function buildRoutingChecks(metrics, thresholds) {
  return [
    createMinimumCheck("operation-accuracy", metrics.operationAccuracy, thresholds.operationAccuracyMin),
    createMinimumCheck("source-image-accuracy", metrics.sourceImageAccuracy, thresholds.sourceAssetAccuracyMin),
    createMinimumCheck(
      "source-reference-accuracy",
      metrics.sourceReferenceAccuracy,
      thresholds.sourceAssetAccuracyMin,
    ),
    createMinimumCheck(
      "source-bytes-accuracy",
      metrics.sourceBytesAccuracy,
      thresholds.sourceAssetAccuracyMin,
    ),
    createMinimumCheck(
      "visual-input-accuracy",
      metrics.visualInputAccuracy,
      thresholds.visualInputAccuracyMin,
    ),
    createMinimumCheck(
      "edit-prompt-history-accuracy",
      metrics.editPromptHistoryAccuracy,
      thresholds.editPromptHistoryAccuracyMin,
    ),
    createMinimumCheck("evidence-validity", metrics.evidenceValidity, thresholds.evidenceValidityMin),
    createMinimumCheck("active-image-accuracy", metrics.activeImageAccuracy, thresholds.activeImageAccuracyMin),
    createMaximumCheck(
      "wrong-image-side-effect-rate",
      metrics.wrongImageSideEffectRate,
      thresholds.unexpectedImageSideEffectRateMax,
    ),
    createMinimumCheck("candidate-set-accuracy", metrics.candidateSetAccuracy, 1),
    createMinimumCheck("use-active-image-accuracy", metrics.useActiveImageAccuracy, 1),
    createMinimumCheck("artifact-count-accuracy", metrics.artifactCountAccuracy, 1),
    createMaximumCheck("execution-error-count", metrics.executionErrorCount, 0),
  ];
}

/** 创建数值不得低于阈值的检查结果。 */
function createMinimumCheck(name, actual, expected) {
  return { name, passed: actual >= expected, actual, comparator: ">=", expected };
}

/** 创建数值不得高于阈值的检查结果。 */
function createMaximumCheck(name, actual, expected) {
  return { name, passed: actual <= expected, actual, comparator: "<=", expected };
}

/** 聚合 Suite 级摘要、模型证据、token、耗时和核心指标。 */
function buildSuiteReport({ mode, modelAlias, startedAt, durationMs, scenarios }) {
  const executed = [];
  const skipped = [];
  const turns = [];
  const classifierCalls = [];
  for (const scenario of scenarios) {
    if (scenario.status === "skipped") skipped.push(scenario);
    else executed.push(scenario);
    for (const turn of scenario.turns || []) {
      turns.push(turn);
      classifierCalls.push(...readTurnClassifierCalls(turn));
    }
  }
  const classifierModels = new Set();
  for (const call of classifierCalls) {
    if (call.model) classifierModels.add(call.model);
  }
  const passed = countScenariosByStatus(executed, "passed");
  const failed = countScenariosByStatus(executed, "failed");
  const validClassifierSampleCount = countValidClassifierSampleTurns(turns);
  const conclusionPolicy = resolveRuntimeRoutingConclusionPolicy({
    mode,
    validClassifierSampleCount,
  });
  return {
    schemaVersion: RUNTIME_ROUTING_REPORT_VERSION,
    mode,
    resultClass: mode === "deterministic"
      ? "routing-execution-regression"
      : "real-model-routing-quality",
    conclusionPolicy,
    minimumGateSampleCount: REPORT_SAMPLE_GATE,
    startedAt,
    durationMs: roundMilliseconds(durationMs),
    requestedModelAlias: mode === "real-model" ? String(modelAlias) : null,
    actualClassifierModels: [...classifierModels].sort(compareStrings),
    summary: {
      executed: executed.length,
      passed,
      failed,
      skipped: skipped.length,
      turnCount: turns.length,
      classifierAttemptCount: classifierCalls.length,
      validClassifierSampleCount,
      executionErrorCount: countTurnsByStatus(turns, "failed"),
    },
    metrics: calculateRoutingMetrics(turns),
    usage: aggregateClassifierUsage(turns),
    latency: {
      routing: summarizeLatency(readClassifierDurations(turns)),
      endToEnd: summarizeLatency(readRunDurations(turns)),
    },
    scenarios,
  };
}

/** 汇总分类请求状态，区分模型失败、安全回退和未触发分类。 */
function summarizeClassifierCalls(turns) {
  const calls = [];
  for (const turn of turns) calls.push(...readTurnClassifierCalls(turn));
  let completed = 0;
  let failed = 0;
  for (const call of calls) {
    if (call.status === "completed") completed += 1;
    else failed += 1;
  }
  const notRequired = turns.filter(hasNoClassifierCalls).length;
  return {
    requested: completed + failed,
    completed,
    failed,
    invalidOutput: completed - countValidClassifierCalls(calls),
    validSamples: countValidClassifierSampleTurns(turns),
    notRequired,
  };
}

/** 汇总已完成分类调用的 OpenAI-compatible token 字段，缺失项保持 null。 */
function aggregateClassifierUsage(turns) {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let promptMeasured = false;
  let completionMeasured = false;
  let totalMeasured = false;
  const calls = [];
  for (const turn of turns) calls.push(...readTurnClassifierCalls(turn));
  for (const call of calls) {
    const usage = call.usage;
    if (Number.isFinite(usage?.promptTokens)) {
      promptTokens += usage.promptTokens;
      promptMeasured = true;
    }
    if (Number.isFinite(usage?.completionTokens)) {
      completionTokens += usage.completionTokens;
      completionMeasured = true;
    }
    if (Number.isFinite(usage?.totalTokens)) {
      totalTokens += usage.totalTokens;
      totalMeasured = true;
    }
  }
  return {
    coverage: "intent-classifier-completed-calls",
    promptTokens: promptMeasured ? promptTokens : null,
    completionTokens: completionMeasured ? completionTokens : null,
    totalTokens: totalMeasured ? totalTokens : null,
  };
}

/** 将 provider usage 收敛为三个可空数值，不保存原始 provider 字段。 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    promptTokens: firstFiniteNumber(usage.prompt_tokens, usage.input_tokens, usage.inputTokens),
    completionTokens: firstFiniteNumber(
      usage.completion_tokens,
      usage.output_tokens,
      usage.outputTokens,
    ),
    totalTokens: firstFiniteNumber(usage.total_tokens, usage.totalTokens),
  };
}

/** 返回参数中首个有限数值，否则返回 null。 */
function firstFiniteNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return Number(value);
  }
  return null;
}

/** 将分类旁路记录收敛为可写报告的稳定字段。 */
function sanitizeClassifierCall(call) {
  if (!call) {
    return {
      status: "not-required",
      durationMs: null,
      model: null,
      usage: null,
      outputValid: false,
    };
  }
  return {
    status: call.status,
    durationMs: roundMilliseconds(call.durationMs),
    model: call.model || null,
    usage: call.usage ? { ...call.usage } : null,
    outputValid: Boolean(call.outputValid),
    ...(call.errorCode ? { errorCode: call.errorCode } : {}),
  };
}

/** 返回轮次中实际发起的全部分类调用，兼容不含数组的旧报告对象。 */
function readTurnClassifierCalls(turn) {
  if (Array.isArray(turn?.classifierCalls)) return turn.classifierCalls;
  return turn?.classifier?.status && turn.classifier.status !== "not-required"
    ? [turn.classifier]
    : [];
}

/** 判断轮次没有实际发起任何结构化意图分类调用。 */
function hasNoClassifierCalls(turn) {
  return readTurnClassifierCalls(turn).length === 0;
}

/** 统计真实完成且通过本轮动态输出 schema 校验的分类调用。 */
function countValidClassifierCalls(calls) {
  let count = 0;
  for (const call of calls) {
    if (call.status === "completed" && call.outputValid === true) count += 1;
  }
  return count;
}

/** 按唯一轮次统计最终分类调用有效的真实模型质量样本，避免重路由尝试膨胀分母。 */
function countValidClassifierSampleTurns(turns) {
  let count = 0;
  for (const turn of turns) {
    const calls = readTurnClassifierCalls(turn);
    const finalCall = calls.at(-1);
    if (finalCall?.status === "completed" && finalCall.outputValid === true) count += 1;
  }
  return count;
}

/** 按属性计算布尔命中率；空集合按无待验证错误返回 1。 */
function calculateBooleanRate(items, field) {
  if (items.length === 0) return 1;
  let matched = 0;
  for (const item of items) {
    if (Boolean(item[field])) matched += 1;
  }
  return roundRate(matched / items.length);
}

/** 按属性计算事件发生率；没有符合分母条件的轮次时返回 0。 */
function calculateOccurrenceRate(items, field) {
  if (items.length === 0) return 0;
  let occurred = 0;
  for (const item of items) {
    if (Boolean(item[field])) occurred += 1;
  }
  return roundRate(occurred / items.length);
}

/** 统计具有指定状态的轮次数量。 */
function countTurnsByStatus(turns, status) {
  let count = 0;
  for (const turn of turns) {
    if (turn.status === status) count += 1;
  }
  return count;
}

/** 统计具有指定状态的场景数量。 */
function countScenariosByStatus(scenarios, status) {
  let count = 0;
  for (const scenario of scenarios) {
    if (scenario.status === status) count += 1;
  }
  return count;
}

/** 提取所有已实际发起分类请求的耗时。 */
function readClassifierDurations(turns) {
  const values = [];
  for (const turn of turns) {
    for (const call of readTurnClassifierCalls(turn)) {
      if (Number.isFinite(call.durationMs)) values.push(call.durationMs);
    }
  }
  return values;
}

/** 提取所有已尝试 Runtime Run 的端到端耗时。 */
function readRunDurations(turns) {
  const values = [];
  for (const turn of turns) {
    if (Number.isFinite(turn.runDurationMs)) values.push(turn.runDurationMs);
  }
  return values;
}

/** 对耗时样本计算平均、P50、P95 和最大值。 */
function summarizeLatency(values) {
  if (values.length === 0) {
    return { sampleCount: 0, averageMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sorted = [...values].sort(compareNumbers);
  let total = 0;
  for (const value of sorted) total += value;
  return {
    sampleCount: sorted.length,
    averageMs: roundMilliseconds(total / sorted.length),
    p50Ms: roundMilliseconds(readPercentile(sorted, 0.5)),
    p95Ms: roundMilliseconds(readPercentile(sorted, 0.95)),
    maxMs: roundMilliseconds(sorted.at(-1)),
  };
}

/** 从已排序样本读取 nearest-rank 百分位。 */
function readPercentile(sorted, ratio) {
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

/** 为不支持当前模式的场景生成显式跳过结果。 */
function buildSkippedScenarioResult(scenario, mode) {
  return {
    id: scenario.definition.id,
    fixtureVersion: scenario.definition.version,
    mode,
    status: "skipped",
    classifierConfiguration: buildClassifierConfiguration(scenario),
    reasonCode: "mode_not_supported",
    turns: [],
  };
}

/** 为基础设施或装配异常生成不泄露原文的场景失败结果。 */
function buildFailedScenarioResult(scenario, mode, error, durationMs, keepArtifacts, workingDirectory) {
  return {
    id: scenario.definition.id,
    fixtureVersion: scenario.definition.version,
    mode,
    status: "failed",
    classifierConfiguration: buildClassifierConfiguration(scenario),
    durationMs: roundMilliseconds(durationMs),
    reasonCode: readSafeErrorCode(error),
    temporaryArtifactsKept: Boolean(keepArtifacts),
    ...(keepArtifacts ? { workingDirectory } : {}),
    turns: [],
  };
}

/** 把 case 固定的分类 Prompt、schema、采样和门禁参数写入报告，保证跨次结果可比。 */
function buildClassifierConfiguration(scenario) {
  const classifier = scenario.definition.classifier;
  return {
    promptVersion: classifier.promptVersion,
    outputSchemaName: RUN_INTENT_OUTPUT_SCHEMA_NAME,
    decisionSchemaVersion: RUN_INTENT_DECISION_SCHEMA_VERSION,
    temperature: classifier.temperature,
    maxCompletionTokens: classifier.maxCompletionTokens,
    confidenceThreshold: classifier.confidenceThreshold,
  };
}

/** 从 Runtime、Gateway 或普通异常中读取稳定错误码，不保存异常正文。 */
function readSafeErrorCode(error) {
  return String(error?.payload?.code || error?.code || error?.name || "runtime_routing_evaluation_failed")
    .slice(0, 160);
}

/** 把 sidecar 条目按会话和轮次建立唯一索引。 */
function indexTurnEntries(entries) {
  const index = new Map();
  for (const entry of entries) index.set(toTurnKey(entry.conversationId, entry.turnId), entry);
  return index;
}

/** 读取控制器当前轮 sidecar；缺失轮次属于 fixture 基础设施错误。 */
function readCurrentFixtureEntry(index, current, label) {
  if (!current) throw new Error(`${label} turn is not selected`);
  const entry = index.get(toTurnKey(current.conversationId, current.turnId));
  if (!entry) throw new Error(`${label} is missing current turn`);
  return entry;
}

/** 在 sidecar 列表中读取指定会话轮次。 */
function findTurnEntry(entries, conversationId, turnId, label) {
  for (const entry of entries) {
    if (entry.conversationId === conversationId && entry.turnId === turnId) return entry;
  }
  throw new Error(`${label} is missing turn: ${conversationId}/${turnId}`);
}

/** 创建将逻辑消息证据映射为真实 Store 消息 ID 的解析函数。 */
function createMessageReferenceResolver(messageTargets) {
  /** 解析严格历史消息，fixture 违反时立即失败而非伪造 ID。 */
  function resolveMessageReference(reference) {
    const id = messageTargets.get(toMessageTargetKey(reference.turnId, reference.role));
    if (!id) throw new Error(`fixture message target is unavailable: ${reference.turnId}/${reference.role}`);
    return id;
  }
  return resolveMessageReference;
}

/** 从资产映射解析 fixture 上传或历史/当前轮产物。 */
function resolveAssetTarget(target, assetTargets) {
  const key = target.kind === "fixture-asset"
    ? toFixtureAssetKey(target.assetId)
    : toTurnArtifactKey(target.turnId, target.index ?? 0);
  const assetId = assetTargets.get(key);
  if (!assetId) throw new Error(`fixture asset target is unavailable: ${key}`);
  return assetId;
}

/** 生成会话和轮次组合键。 */
function toTurnKey(conversationId, turnId) {
  return `${conversationId}/${turnId}`;
}

/** 生成逻辑消息角色键。 */
function toMessageTargetKey(turnId, role) {
  return `message:${turnId}:${role}`;
}

/** 生成上传 fixture 资产键。 */
function toFixtureAssetKey(assetId) {
  return `fixture:${assetId}`;
}

/** 生成轮次图片产物键。 */
function toTurnArtifactKey(turnId, index) {
  return `artifact:${turnId}:${index}`;
}

/** 比较两个字符串数组的长度、顺序和值。 */
function equalStringArrays(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** 读取检查通过状态，供场景终态归约。 */
function readCheckPassed(check) {
  return check.passed;
}

/** 比较数值，供延迟样本稳定排序。 */
function compareNumbers(left, right) {
  return left - right;
}

/** 比较字符串，供模型别名稳定排序。 */
function compareStrings(left, right) {
  return left.localeCompare(right, "en");
}

/** 将毫秒保留三位小数，避免报告包含无意义浮点噪声。 */
function roundMilliseconds(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

/** 将准确率保留六位小数。 */
function roundRate(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** 将有限数值保留原值，缺失值收敛为 null。 */
function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

/** 拒绝未知执行模式。 */
function assertRoutingMode(mode) {
  if (!RUNTIME_ROUTING_SCENARIO_MODES.includes(mode)) {
    throw new TypeError(`unsupported runtime routing scenario mode: ${mode}`);
  }
}

/** 真实模型评测必须由调用方固定别名，避免默认模型漂移污染对比。 */
function assertRealModelAlias(mode, modelAlias) {
  if (mode === "real-model" && !String(modelAlias || "").trim()) {
    throw new TypeError("real-model runtime routing scenarios require an explicit model alias");
  }
}

/** case 必须固定当前生产 Router Prompt 版本，防止报告混合不同分类规则。 */
function assertClassifierPromptVersion(promptVersion) {
  if (promptVersion !== RUN_INTENT_ROUTER_VERSION) {
    throw new Error(`runtime routing classifier version mismatch: ${promptVersion}`);
  }
}

/** 选定场景白名单中存在未知 ID 时立即失败，避免产生空报告。 */
function assertSelectedScenariosExist(selectedIds, discoveredIds) {
  for (const id of selectedIds) {
    if (!discoveredIds.has(id)) throw new Error(`unknown runtime routing scenario: ${id}`);
  }
}

/** 背景记忆任务不属于路由评测范围；高水位未触发时该 Port 不应被调用。 */
function ignoreBackgroundMemoryError() {}

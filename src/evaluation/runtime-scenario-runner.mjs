import { spawn } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadDemoConfig } from "../config/env.mjs";
import { createGatewayClient } from "../gateway/gateway-client.mjs";
import { createChatRuntime } from "../runtime/chat-runtime.mjs";
import { createConversationCoordinator } from "../runtime/conversation-coordinator.mjs";
import { createContextPlanner } from "../runtime/context-planner.mjs";
import { createMemoryManager } from "../runtime/memory-manager.mjs";
import { createConversationStore } from "../storage/conversation-store.mjs";
import { createToolRegistry } from "../tools/tool-registry.mjs";
import { createDeterministicModelFetch } from "./deterministic-model-adapter.mjs";
import {
  RUNTIME_SCENARIO_MODES,
  discoverRuntimeScenarioDirectories,
  loadRuntimeScenario,
} from "./runtime-scenario-contract.mjs";

export const RUNTIME_SCENARIO_REPORT_VERSION = "runtime-scenario-report.v1";

const DEFAULT_CONTEXT_OPTIONS = Object.freeze({
  maxContextTokens: 12000,
  reservedOutputTokens: 2000,
  safetyTokens: 500,
  highWatermarkRatio: 0.75,
  lowWatermarkRatio: 0.45,
  hardWatermarkRatio: 0.9,
});

/**
 * @typedef {object} RuntimeScenarioAssembly
 * @property {object} runtime - 生产 Chat Runtime 实例。
 * @property {object} store - SQLite Conversation Store。
 * @property {object} gatewayClient - 现有 GatewayClient。
 * @property {string} modelAlias - 本次 Run 使用的模型别名。
 * @property {() => number} getToolExecutionCount - 当前进程内 Connector 执行次数。
 * @property {() => void} close - 释放 SQLite 连接。
 */

/**
 * 装配场景使用的真实 Runtime 主链，只允许在 Model Port 和固定 Connector fixture 处注入。
 *
 * @param {object} input - 场景装配参数。
 * @param {object} input.scenario - 已加载场景。
 * @param {"deterministic"|"real-model"} input.mode - 模型执行模式。
 * @param {string} input.databasePath - 当前场景唯一 SQLite 路径。
 * @param {string} input.rootDir - 项目根目录。
 * @param {string} [input.modelAlias] - 真实模型显式覆盖别名。
 * @param {string} [input.modelEvidencePath] - 仅记录实际模型与 usage 的 JSONL 旁路证据。
 * @param {"setup"|"evaluation"} [input.modelEvidencePhase="evaluation"] - 报告中的模型调用阶段。
 * @param {boolean} [input.denyToolExecution=false] - 恢复阶段禁止 Connector 重放。
 * @returns {Promise<RuntimeScenarioAssembly>} 可运行并可审计的场景装配。
 */
export async function createRuntimeScenarioAssembly({
  scenario,
  mode,
  databasePath,
  rootDir,
  modelAlias,
  modelEvidencePath,
  modelEvidencePhase = "evaluation",
  denyToolExecution = false,
}) {
  assertScenarioMode(mode);
  const gateway = await createScenarioGateway({
    scenario,
    mode,
    rootDir,
    modelAlias,
    modelEvidencePath,
    modelEvidencePhase,
  });
  const evaluationGatewayClient = applyScenarioEvaluationParameters(
    gateway.gatewayClient,
    scenario.definition.evaluation,
  );
  const toolFixture = createScenarioToolFixture(scenario.definition.tools, { denyToolExecution });
  const store = createConversationStore({ databasePath });
  const coordinator = createConversationCoordinator();
  const contextPlanner = createContextPlanner({
    store,
    gatewayClient: evaluationGatewayClient,
    contextOptions: DEFAULT_CONTEXT_OPTIONS,
    systemPrompt: scenario.definition.prompt.system,
  });
  const memoryManager = createMemoryManager({
    store,
    gatewayClient: evaluationGatewayClient,
    contextOptions: DEFAULT_CONTEXT_OPTIONS,
    onError: ignoreBackgroundMemoryError,
  });
  const runtime = createChatRuntime({
    gatewayClient: evaluationGatewayClient,
    contextOptions: DEFAULT_CONTEXT_OPTIONS,
    store,
    coordinator,
    contextPlanner,
    memoryManager,
    toolRegistry: toolFixture.registry,
    toolOptions: { maxSteps: scenario.definition.runtime.maxToolSteps },
    resilienceOptions: { runTimeoutMs: scenario.definition.runtime.runTimeoutMs },
  });

  return {
    runtime,
    store,
    gatewayClient: evaluationGatewayClient,
    modelAlias: gateway.modelAlias,
    getToolExecutionCount: toolFixture.getExecutionCount,
    /** 关闭当前场景的 SQLite 连接。 */
    close() {
      store.close();
    },
  };
}

/**
 * 在评测装配边界固定采样与输出参数，不改变生产 GatewayClient 或 Runtime 契约。
 *
 * @param {object} gatewayClient - 现有 GatewayClient 实例。
 * @param {{temperature: number, maxCompletionTokens: number}} parameters - 版本化场景参数。
 * @returns {object} 仅覆盖文本生成入口的 GatewayClient 代理。
 */
function applyScenarioEvaluationParameters(gatewayClient, parameters) {
  return {
    ...gatewayClient,
    /** 将场景声明参数作为最终值注入每次评测文本调用。 */
    async chatCompletions(input) {
      return gatewayClient.chatCompletions({ ...input, ...parameters });
    },
  };
}

/**
 * 运行目录中的全部版本化场景，并分开生成确定性链路或真实模型质量报告。
 *
 * @param {object} input - Suite 执行参数。
 * @param {string} input.rootDir - 项目根目录。
 * @param {"deterministic"|"real-model"} input.mode - 执行模式。
 * @param {string[]} [input.scenarioIds] - 可选场景 ID 白名单。
 * @param {string} [input.modelAlias] - 真实模式模型别名覆盖。
 * @param {boolean} [input.keepArtifacts=false] - 是否保留临时 SQLite。
 * @returns {Promise<object>} runtime-scenario-report.v1 报告。
 */
export async function runRuntimeScenarioSuite({
  rootDir,
  mode,
  scenarioIds = [],
  modelAlias,
  keepArtifacts = false,
}) {
  assertScenarioMode(mode);
  assertRealModelAlias(mode, modelAlias);
  const startedAt = new Date().toISOString();
  const suiteStarted = performance.now();
  const scenariosRoot = join(rootDir, "scenarios", "runtime");
  const directories = await discoverRuntimeScenarioDirectories(scenariosRoot);
  const selectedIds = new Set(scenarioIds);
  const results = [];

  for (const directory of directories) {
    const scenario = await loadRuntimeScenario(directory);
    if (selectedIds.size > 0 && !selectedIds.has(scenario.definition.id)) continue;
    if (!scenario.definition.supportedModes.includes(mode)) {
      results.push(buildSkippedScenarioResult(scenario, mode));
      continue;
    }
    results.push(await runRuntimeScenario({ rootDir, scenario, mode, modelAlias, keepArtifacts }));
  }

  assertRequestedScenariosFound(selectedIds, results);
  const finishedAt = new Date().toISOString();
  return buildSuiteReport({
    mode,
    startedAt,
    finishedAt,
    durationMs: performance.now() - suiteStarted,
    results,
  });
}

/**
 * 把报告写入被 .gitignore 排除的运行证据目录。
 *
 * @param {object} report - runtime-scenario-report.v1 报告。
 * @param {string} reportPath - 目标 JSON 路径。
 * @returns {Promise<string>} 绝对报告路径。
 */
export async function writeRuntimeScenarioReport(report, reportPath) {
  const absolutePath = resolve(reportPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return absolutePath;
}

/** 运行一个进程退出、重启恢复和独立验收闭环。 */
async function runRuntimeScenario({ rootDir, scenario, mode, modelAlias, keepArtifacts }) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const artifactDirectory = await mkdtemp(join(tmpdir(), `ai-platform-${scenario.definition.id}-`));
  const databasePath = join(artifactDirectory, "scenario.sqlite");
  const modelEvidencePath = join(artifactDirectory, "model-calls.jsonl");
  let assembly = null;

  try {
    const crash = await runFaultWorker({
      rootDir,
      scenario,
      modelAlias,
      databasePath,
      modelEvidencePath,
    });
    if (crash.exitCode !== scenario.definition.fault.exitCode) {
      throw createScenarioStageError("fault-injection", "场景子进程未在 ToolResult 提交后按约定退出", {
        expectedExitCode: scenario.definition.fault.exitCode,
        actualExitCode: crash.exitCode,
        stderr: sanitizeDiagnostic(crash.stderr),
      });
    }

    assembly = await createRuntimeScenarioAssembly({
      scenario,
      mode,
      databasePath,
      rootDir,
      modelAlias,
      modelEvidencePath,
      modelEvidencePhase: "evaluation",
      denyToolExecution: true,
    });
    const checkpoints = assembly.store.listRunningRuns();
    const checkpoint = checkpoints.length === 1 ? checkpoints[0] : null;
    const recoveryStarted = performance.now();
    const recovery = await assembly.runtime.recoverInterruptedRuns();
    const recoveryDurationMs = performance.now() - recoveryStarted;
    const conversationId = checkpoint?.run?.conversationId || assembly.store.listConversations()[0]?.id;
    const conversation = conversationId ? assembly.runtime.getConversation(conversationId) : null;
    const modelCalls = await readModelCallEvidence(modelEvidencePath);
    const events = conversationId ? assembly.store.listEventsAfter(conversationId) : [];
    const observation = {
      mode,
      crash: {
        exitCode: crash.exitCode,
        durationMs: roundMilliseconds(crash.durationMs),
      },
      checkpoint: checkpoint ? toCheckpointEvidence(checkpoint) : null,
      recovery,
      recoveryDurationMs: roundMilliseconds(recoveryDurationMs),
      connectorExecutionsAfterRestart: assembly.getToolExecutionCount(),
      modelCalls,
      conversation,
      events,
    };
    const acceptance = normalizeScenarioAcceptance(
      await scenario.acceptance.evaluateScenario({ definition: scenario.definition, observation }),
    );
    return buildScenarioResult({
      scenario,
      mode,
      startedAt,
      durationMs: performance.now() - started,
      modelAlias: assembly.modelAlias,
      observation,
      acceptance,
      artifactDirectory: keepArtifacts ? artifactDirectory : null,
    });
  } catch (error) {
    return buildInfrastructureFailure({
      scenario,
      mode,
      startedAt,
      durationMs: performance.now() - started,
      modelAlias: modelAlias || null,
      error,
      artifactDirectory: keepArtifacts ? artifactDirectory : null,
    });
  } finally {
    if (assembly) assembly.close();
    if (!keepArtifacts) await rm(artifactDirectory, { recursive: true, force: true });
  }
}

/** 启动真实子进程，并在 ToolResult 已提交时制造不可被 finally 收口的退出窗口。 */
async function runFaultWorker({ rootDir, scenario, modelAlias, databasePath, modelEvidencePath }) {
  const workerPath = join(rootDir, "scripts", "runtime-scenario-worker.mjs");
  const argumentsList = [
    workerPath,
    "--scenario",
    scenario.directory,
    "--mode",
    "deterministic",
    "--database",
    databasePath,
    "--model-evidence",
    modelEvidencePath,
  ];
  if (modelAlias) argumentsList.push("--model", modelAlias);
  const timeoutMs = scenario.definition.runtime.runTimeoutMs + 10_000;
  const started = performance.now();

  return new Promise(
    /** 管理故障子进程的输出上限、硬超时和退出事实。 */
    (resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    /** 收集有限标准输出，仅供失败诊断，不进入成功报告。 */
    function collectStdout(chunk) {
      stdout = appendLimited(stdout, chunk);
    }

    /** 收集有限标准错误，避免异常输出无限占用内存。 */
    function collectStderr(chunk) {
      stderr = appendLimited(stderr, chunk);
    }

    /** 在场景总预算之外终止失去进展的子进程。 */
    function terminateTimedOutWorker() {
      timedOut = true;
      child.kill("SIGKILL");
    }

    /** 将进程启动失败交给 Suite 基础设施错误处理。 */
    function handleWorkerError(error) {
      clearTimeout(timeout);
      rejectPromise(error);
    }

    /** 返回退出码、耗时和有限诊断文本。 */
    function handleWorkerClosed(exitCode, signal) {
      clearTimeout(timeout);
      if (timedOut) {
        rejectPromise(createScenarioStageError("fault-injection", "场景子进程超过运行时限", { timeoutMs }));
        return;
      }
      resolvePromise({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal || null,
        stdout,
        stderr,
        durationMs: performance.now() - started,
      });
    }

      const timeout = setTimeout(terminateTimedOutWorker, timeoutMs);
      child.stdout.on("data", collectStdout);
      child.stderr.on("data", collectStderr);
      child.once("error", handleWorkerError);
      child.once("close", handleWorkerClosed);
    },
  );
}

/** 根据模式创建固定模型 Adapter 或真实 LiteLLM GatewayClient。 */
async function createScenarioGateway({
  scenario,
  mode,
  rootDir,
  modelAlias,
  modelEvidencePath,
  modelEvidencePhase,
}) {
  if (mode === "deterministic") {
    const alias = String(modelAlias || scenario.definition.deterministicModel.alias).trim();
    const modelFetch = createDeterministicModelFetch({ scenario, modelAlias: alias });
    return {
      modelAlias: alias,
      gatewayClient: createGatewayClient({
        baseUrl: "http://deterministic-model.invalid",
        model: alias,
        apiKey: "scenario-local-key",
        retryBaseDelayMs: 0,
        fetchImplementation: createModelEvidenceFetch({
          fetchImplementation: modelFetch,
          evidencePath: modelEvidencePath,
          phase: modelEvidencePhase,
        }),
      }),
    };
  }

  const config = await loadDemoConfig(rootDir);
  const alias = String(modelAlias || config.gateway.model).trim();
  if (!alias) throw createScenarioStageError("configuration", "真实模型别名不能为空");
  return {
    modelAlias: alias,
    gatewayClient: createGatewayClient({
      ...config.gateway,
      model: alias,
      fetchImplementation: createModelEvidenceFetch({
        fetchImplementation: fetch,
        evidencePath: modelEvidencePath,
        phase: modelEvidencePhase,
      }),
    }),
  };
}

/**
 * 包装模型 Fetch Port，只提取 chat completion 的实际模型、usage 和完成时间。
 *
 * @param {object} input - 下游 Fetch 和可选 JSONL 证据路径。
 * @param {typeof fetch} input.fetchImplementation - 固定模型或真实 LiteLLM Fetch。
 * @param {string} [input.evidencePath] - 场景临时目录中的证据文件。
 * @param {"setup"|"evaluation"} input.phase - 模型调用所属评测阶段。
 * @returns {typeof fetch} 不改变原响应语义的 Fetch Adapter。
 */
function createModelEvidenceFetch({ fetchImplementation, evidencePath, phase }) {
  /** 调用原 Fetch，并在返回给 AI SDK 前从响应副本提取非正文证据。 */
  async function evidenceFetch(input, init) {
    const recordsEvidence = Boolean(evidencePath) && isChatCompletionsRequest(input);
    if (recordsEvidence) {
      await appendModelEvidence(evidencePath, {
        phase,
        status: "started",
        occurredAt: new Date().toISOString(),
      });
    }
    try {
      const response = await fetchImplementation(input, init);
      if (!recordsEvidence) return response;
      if (!response.ok) {
        await appendModelEvidence(evidencePath, {
          phase,
          status: "failed",
          failureType: "http-response",
          httpStatus: response.status,
          occurredAt: new Date().toISOString(),
        });
        return response;
      }
      const evidence = await extractModelCallEvidence(response.clone());
      await appendModelEvidence(evidencePath, {
        phase,
        status: "completed",
        model: evidence?.model || null,
        usage: evidence?.usage || null,
        completedAt: evidence?.completedAt || new Date().toISOString(),
      });
      return response;
    } catch (error) {
      if (recordsEvidence) {
        await appendModelEvidence(evidencePath, {
          phase,
          status: "failed",
          failureType: "transport",
          httpStatus: null,
          occurredAt: new Date().toISOString(),
        });
      }
      throw error;
    }
  }
  return evidenceFetch;
}

/** 追加不含请求或响应正文的单条模型调用生命周期证据。 */
async function appendModelEvidence(evidencePath, evidence) {
  await appendFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
}

/** 判断请求 URL 是否为 OpenAI-compatible chat completions 端点。 */
function isChatCompletionsRequest(input) {
  const url = input instanceof Request ? input.url : String(input);
  try {
    return new URL(url).pathname === "/v1/chat/completions";
  } catch {
    return false;
  }
}

/** 从 JSON 或 SSE 响应副本提取实际模型和 usage，不保留消息正文。 */
async function extractModelCallEvidence(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  try {
    if (contentType.includes("text/event-stream")) return extractSseModelCallEvidence(await response.text());
    return toModelCallEvidence(await response.json());
  } catch {
    return null;
  }
}

/** 从 SSE 数据行合并最后出现的模型名与 usage。 */
function extractSseModelCallEvidence(content) {
  let model = null;
  let usage = null;
  for (const line of String(content || "").split(/\r?\n/u)) {
    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(5).trim());
      model = String(chunk?.model || model || "").trim() || null;
      if (chunk?.usage) usage = normalizeEvidenceUsage(chunk.usage);
    } catch {
      // 非 JSON SSE 行不构成模型调用证据，也不影响原响应消费。
    }
  }
  return model || usage ? { model, usage, completedAt: new Date().toISOString() } : null;
}

/** 将 JSON completion 收敛为不含正文的模型调用证据。 */
function toModelCallEvidence(payload) {
  const model = String(payload?.model || "").trim() || null;
  const usage = normalizeEvidenceUsage(payload?.usage);
  return model || usage ? { model, usage, completedAt: new Date().toISOString() } : null;
}

/** 只允许标准 token 数进入旁路证据，其他 provider 字段全部丢弃。 */
function normalizeEvidenceUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: finiteNumber(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens),
    outputTokens: finiteNumber(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens),
    totalTokens: finiteNumber(usage.total_tokens ?? usage.totalTokens),
  };
}

/** 读取场景临时 JSONL 中的模型调用证据；文件不存在表示调用未完成。 */
async function readModelCallEvidence(evidencePath) {
  let content;
  try {
    content = await readFile(evidencePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const calls = [];
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim()) calls.push(JSON.parse(line));
  }
  return calls;
}

/** 把声明式只读工具 fixture 适配为现有 Tool Registry，并统计恢复后误调用。 */
function createScenarioToolFixture(toolFixtures, { denyToolExecution }) {
  let executionCount = 0;
  const definitions = [];
  for (const fixture of toolFixtures) {
    definitions.push({
      name: fixture.name,
      title: fixture.title,
      description: fixture.description,
      effect: fixture.effect,
      inputSchema: fixture.inputSchema,
      /** 按场景协议声明首步强制工具，不在 Runner 中识别具体业务关键词。 */
      matchesInput() {
        return fixture.requiredOnStart;
      },
      /** 返回版本化固定 ToolResult；重启恢复阶段任何调用都会明确失败。 */
      async execute() {
        executionCount += 1;
        if (denyToolExecution) throw new Error(`connector replay is forbidden: ${fixture.name}`);
        return structuredClone(fixture.result);
      },
    });
  }
  return {
    registry: createToolRegistry(definitions),
    /** 返回当前进程实际进入 Connector Port 的次数。 */
    getExecutionCount() {
      return executionCount;
    },
  };
}

/** 把恢复前 SQLite 状态压缩为不复制大正文的稳定证据。 */
function toCheckpointEvidence(checkpoint) {
  return {
    runId: checkpoint.run.id,
    conversationId: checkpoint.run.conversationId,
    status: checkpoint.run.status,
    model: checkpoint.run.model,
    deadlineAt: checkpoint.run.deadlineAt,
    chainTraceId: checkpoint.run.chainTraceId,
    userMessageId: checkpoint.userMessage?.id || null,
    assistantMessagePresent: Boolean(checkpoint.assistantMessage),
    toolCalls: checkpoint.toolCalls.map(toToolCheckpoint),
  };
}

/** 映射一个 ToolCall 的恢复资格字段。 */
function toToolCheckpoint(toolCall) {
  return {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    status: toolCall.status,
    source: toolCall.source,
    observedAt: toolCall.observedAt,
  };
}

/** 校验场景验收器返回统一 passed/checks 结构。 */
function normalizeScenarioAcceptance(value) {
  if (!value || typeof value !== "object" || typeof value.passed !== "boolean") {
    throw new TypeError("scenario acceptance must return { passed, checks }");
  }
  const checks = Array.isArray(value.checks) ? value.checks : [];
  return {
    passed: value.passed,
    checks,
    summary: String(value.summary || (value.passed ? "场景验收通过" : "场景验收失败")),
  };
}

/** 创建一个包含模型、usage、延迟和验收证据的场景结果。 */
function buildScenarioResult({
  scenario,
  mode,
  startedAt,
  durationMs,
  modelAlias,
  observation,
  acceptance,
  artifactDirectory,
}) {
  const latestRun = observation.conversation?.latestRun || null;
  const modelEvents = Array.isArray(observation.modelCalls) ? observation.modelCalls : [];
  const setupEvents = modelEvents.filter(isSetupModelCall);
  const evaluationEvents = modelEvents.filter(isEvaluationModelCall);
  const setupCalls = setupEvents.filter(isCompletedModelCall);
  const evaluationCalls = evaluationEvents.filter(isCompletedModelCall);
  const actualModels = uniqueValues(evaluationCalls.map(readModelCallModel));
  const measuredUsage = aggregateModelCallUsage(evaluationCalls);
  return {
    id: scenario.definition.id,
    fixtureVersion: scenario.definition.version,
    promptVersion: scenario.definition.prompt.version,
    evaluationParameters: { ...scenario.definition.evaluation },
    mode,
    status: acceptance.passed ? "passed" : "failed",
    startedAt,
    durationMs: roundMilliseconds(durationMs),
    evaluationDurationMs: roundMilliseconds(observation.recoveryDurationMs),
    modelAlias,
    actualModel: actualModels[actualModels.length - 1] || null,
    actualModels,
    modelRequestCount: evaluationEvents.filter(isStartedModelCall).length,
    modelCallCount: evaluationCalls.length,
    modelFailureCount: evaluationEvents.filter(isFailedModelCall).length,
    usage: {
      ...measuredUsage,
      coverage: "evaluation-phase-completed-chat-completion-responses",
    },
    setup: {
      mode: "deterministic",
      durationMs: roundMilliseconds(observation.crash?.durationMs),
      actualModels: uniqueValues(setupCalls.map(readModelCallModel)),
      modelRequestCount: setupEvents.filter(isStartedModelCall).length,
      modelCallCount: setupCalls.length,
      modelFailureCount: setupEvents.filter(isFailedModelCall).length,
      usage: aggregateModelCallUsage(setupCalls),
    },
    run: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          errorCode: latestRun.errorCode,
          acceptance: latestRun.acceptance,
          toolCallCount: latestRun.toolCalls.length,
        }
      : null,
    recovery: observation.recovery,
    connectorExecutionsAfterRestart: observation.connectorExecutionsAfterRestart,
    acceptance,
    artifactDirectory,
  };
}

/** 将执行器异常收敛为不含密钥和 provider body 的失败结果。 */
function buildInfrastructureFailure({ scenario, mode, startedAt, durationMs, modelAlias, error, artifactDirectory }) {
  return {
    id: scenario.definition.id,
    fixtureVersion: scenario.definition.version,
    promptVersion: scenario.definition.prompt.version,
    evaluationParameters: { ...scenario.definition.evaluation },
    mode,
    status: "failed",
    startedAt,
    durationMs: roundMilliseconds(durationMs),
    evaluationDurationMs: null,
    modelAlias,
    actualModel: null,
    actualModels: [],
    modelRequestCount: 0,
    modelCallCount: 0,
    modelFailureCount: 0,
    usage: { ...normalizeRunUsage(null), coverage: "unavailable" },
    setup: null,
    run: null,
    recovery: null,
    connectorExecutionsAfterRestart: null,
    acceptance: {
      passed: false,
      checks: [],
      summary: "场景执行基础设施失败",
    },
    error: {
      stage: error?.stage || "runner",
      code: error?.code || error?.payload?.code || "scenario_runner_failed",
      message: String(error?.message || "场景执行失败"),
      details: sanitizeDetails(error?.details),
    },
    artifactDirectory,
  };
}

/** 为当前模式不支持的场景生成明确 skipped 结果。 */
function buildSkippedScenarioResult(scenario, mode) {
  return {
    id: scenario.definition.id,
    fixtureVersion: scenario.definition.version,
    promptVersion: scenario.definition.prompt.version,
    evaluationParameters: { ...scenario.definition.evaluation },
    mode,
    status: "skipped",
    reason: "mode-not-declared-by-scenario",
    modelAlias: null,
    actualModel: null,
    actualModels: [],
    modelRequestCount: 0,
    modelCallCount: 0,
    modelFailureCount: 0,
    usage: { ...normalizeRunUsage(null), coverage: "not-executed" },
    setup: null,
    durationMs: 0,
    evaluationDurationMs: null,
  };
}

/** 汇总分模式报告；真实样本不足 30 时只标记观察结果。 */
function buildSuiteReport({ mode, startedAt, finishedAt, durationMs, results }) {
  const executed = results.filter(isExecutedResult);
  const passed = results.filter(isPassedResult).length;
  const failed = results.filter(isFailedResult).length;
  const skipped = results.filter(isSkippedResult).length;
  const durations = executed.map(readEvaluationDuration).filter(isFiniteNumber);
  const usage = aggregateUsage(executed);
  return {
    schemaVersion: RUNTIME_SCENARIO_REPORT_VERSION,
    mode,
    resultClass: mode === "deterministic" ? "execution-regression" : "real-model-quality",
    conclusionPolicy: mode === "real-model" && executed.length < 30 ? "observation-only" : "regression-gate",
    startedAt,
    finishedAt,
    durationMs: roundMilliseconds(durationMs),
    summary: {
      total: results.length,
      executed: executed.length,
      passed,
      failed,
      skipped,
      passRate: executed.length > 0 ? passed / executed.length : null,
    },
    models: {
      aliases: uniqueValues(executed.map(readModelAlias)),
      actual: uniqueValues(executed.flatMap(readActualModels)),
    },
    usage,
    latency: {
      averageMs: durations.length > 0 ? roundMilliseconds(average(durations)) : null,
      p95Ms: durations.length > 0 ? roundMilliseconds(percentile95(durations)) : null,
      maxMs: durations.length > 0 ? roundMilliseconds(Math.max(...durations)) : null,
      coverage: "evaluation-phase-end-to-end",
    },
    scenarios: results,
  };
}

/** 归一化 OpenAI 与 AI SDK 常见 usage 字段。 */
function normalizeRunUsage(usage) {
  return {
    inputTokens: finiteNumber(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.inputTokens),
    outputTokens: finiteNumber(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.outputTokens),
    totalTokens: finiteNumber(usage?.total_tokens ?? usage?.totalTokens),
  };
}

/** 累加已执行场景 token，缺失字段保持 null 而不是伪造为零。 */
function aggregateUsage(results) {
  const inputValues = results.map(readInputTokens).filter(isFiniteNumber);
  const outputValues = results.map(readOutputTokens).filter(isFiniteNumber);
  const totalValues = results.map(readTotalTokens).filter(isFiniteNumber);
  return {
    inputTokens: inputValues.length > 0 ? sum(inputValues) : null,
    outputTokens: outputValues.length > 0 ? sum(outputValues) : null,
    totalTokens: totalValues.length > 0 ? sum(totalValues) : null,
    estimatedCost: null,
    costStatus: "pricing-not-configured",
    coverage: "evaluation-phase-completed-chat-completion-responses",
  };
}

/** 返回结果是否真正执行，跳过项不进入准确率和延迟分母。 */
function isExecutedResult(result) {
  return result.status !== "skipped";
}

/** 返回结果是否通过场景验收。 */
function isPassedResult(result) {
  return result.status === "passed";
}

/** 返回结果是否执行失败或验收失败。 */
function isFailedResult(result) {
  return result.status === "failed";
}

/** 返回结果是否因模式声明而跳过。 */
function isSkippedResult(result) {
  return result.status === "skipped";
}

/** 读取最终回答评测阶段耗时供聚合，setup 不进入模型质量延迟。 */
function readEvaluationDuration(result) {
  return Number.isFinite(result.evaluationDurationMs) ? result.evaluationDurationMs : null;
}

/** 读取报告中的模型别名。 */
function readModelAlias(result) {
  return result.modelAlias;
}

/** 读取报告中的实际模型名。 */
function readActualModel(result) {
  return result.actualModel;
}

/** 返回场景内全部实际模型，兼容只有单值的旧报告对象。 */
function readActualModels(result) {
  return Array.isArray(result.actualModels) && result.actualModels.length > 0
    ? result.actualModels
    : [readActualModel(result)];
}

/** 返回单次旁路模型调用的实际模型名。 */
function readModelCallModel(call) {
  return call?.model;
}

/** 判断旁路调用属于固定模型构造稳定点阶段。 */
function isSetupModelCall(call) {
  return call?.phase === "setup";
}

/** 判断旁路调用属于当前模式的最终质量评测阶段。 */
function isEvaluationModelCall(call) {
  return call?.phase === "evaluation";
}

/** 判断旁路事件表示一次模型 HTTP 请求已经发出。 */
function isStartedModelCall(call) {
  return call?.status === "started";
}

/** 判断旁路事件包含一次成功完成响应的实际模型或 usage。 */
function isCompletedModelCall(call) {
  return call?.status === "completed" || call?.status === undefined;
}

/** 判断旁路事件表示模型请求以 HTTP 或传输错误结束。 */
function isFailedModelCall(call) {
  return call?.status === "failed";
}

/** 汇总一个场景全部已完成 chat completion 的 token。 */
function aggregateModelCallUsage(modelCalls) {
  const usages = modelCalls.map(readModelCallUsage).filter(Boolean);
  return {
    inputTokens: sumNullable(usages.map(readEvidenceInputTokens)),
    outputTokens: sumNullable(usages.map(readEvidenceOutputTokens)),
    totalTokens: sumNullable(usages.map(readEvidenceTotalTokens)),
  };
}

/** 返回模型调用旁路 usage。 */
function readModelCallUsage(call) {
  return call?.usage || null;
}

/** 返回旁路输入 token。 */
function readEvidenceInputTokens(usage) {
  return usage.inputTokens;
}

/** 返回旁路输出 token。 */
function readEvidenceOutputTokens(usage) {
  return usage.outputTokens;
}

/** 返回旁路总 token。 */
function readEvidenceTotalTokens(usage) {
  return usage.totalTokens;
}

/** 仅在至少一个有效数值存在时求和，否则保持 null。 */
function sumNullable(values) {
  const finiteValues = values.filter(isFiniteNumber);
  return finiteValues.length > 0 ? sum(finiteValues) : null;
}

/** 读取输入 token。 */
function readInputTokens(result) {
  return result.usage?.inputTokens;
}

/** 读取输出 token。 */
function readOutputTokens(result) {
  return result.usage?.outputTokens;
}

/** 读取总 token。 */
function readTotalTokens(result) {
  return result.usage?.totalTokens;
}

/** 判断值是否为有限数字。 */
function isFiniteNumber(value) {
  return Number.isFinite(value);
}

/** 把可空数值转换为有限数或 null。 */
function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 对数值数组求和。 */
function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** 计算数值数组算术平均值。 */
function average(values) {
  return sum(values) / values.length;
}

/** 使用 nearest-rank 计算小样本 P95。 */
function percentile95(values) {
  const sorted = [...values].sort(compareNumbers);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

/** 按数值升序比较。 */
function compareNumbers(left, right) {
  return left - right;
}

/** 去除空模型字段并保持首次出现顺序。 */
function uniqueValues(values) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }
  return unique;
}

/** 校验调用方只使用协议允许的两种模式。 */
function assertScenarioMode(mode) {
  if (!RUNTIME_SCENARIO_MODES.includes(mode)) throw new TypeError(`unsupported scenario mode: ${mode}`);
}

/** 真实模型评测必须显式固定别名，禁止从环境默认值静默漂移。 */
function assertRealModelAlias(mode, modelAlias) {
  if (mode === "real-model" && !String(modelAlias || "").trim()) {
    throw new TypeError("real-model mode requires an explicit model alias");
  }
}

/** 校验显式请求的场景均已发现，避免拼写错误导致空跑。 */
function assertRequestedScenariosFound(requestedIds, results) {
  if (requestedIds.size === 0) return;
  const found = new Set(results.map(readScenarioId));
  const missing = [];
  for (const id of requestedIds) {
    if (!found.has(id)) missing.push(id);
  }
  if (missing.length > 0) throw new Error(`runtime scenarios not found: ${missing.join(", ")}`);
}

/** 返回场景结果 ID。 */
function readScenarioId(result) {
  return result.id;
}

/** 创建带阶段与安全详情的 Runner 错误。 */
function createScenarioStageError(stage, message, details = null) {
  const error = new Error(message);
  error.stage = stage;
  error.code = "scenario_stage_failed";
  error.details = details;
  return error;
}

/** 只保留 JSON 安全详情，并再次清理可能出现的鉴权文本。 */
function sanitizeDetails(details) {
  if (!details) return null;
  return { diagnostic: sanitizeDiagnostic(JSON.stringify(details)) };
}

/** 清除常见 Authorization 与 key 文本，成功路径不记录子进程输出。 */
function sanitizeDiagnostic(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]")
    .replace(/sk-[a-z0-9_-]{8,}/giu, "[redacted-key]")
    .slice(0, 4000);
}

/** 有界追加子进程输出，避免异常服务输出拖垮 Runner。 */
function appendLimited(current, chunk) {
  return `${current}${String(chunk)}`.slice(-4000);
}

/** 将耗时保留两位小数，报告字段保持稳定。 */
function roundMilliseconds(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** 场景单轮不会触发可见后台压缩，异常由主 Run 证据负责。 */
function ignoreBackgroundMemoryError() {}

#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeScenarioAssembly } from "../src/evaluation/runtime-scenario-runner.mjs";
import { loadRuntimeScenario } from "../src/evaluation/runtime-scenario-contract.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * 执行场景故障注入阶段，并在 completed ToolResult 已持久化后立即退出进程。
 *
 * 该 Worker 只由通用 Runner 启动；直接退出用于模拟进程丢失，不能放入生产启动链。
 */
async function main() {
  const options = parseWorkerArguments(process.argv.slice(2));
  const scenario = await loadRuntimeScenario(options.scenarioDirectory);
  const assembly = await createRuntimeScenarioAssembly({
    scenario,
    mode: options.mode,
    databasePath: options.databasePath,
    rootDir,
    modelAlias: options.modelAlias,
    modelEvidencePath: options.modelEvidencePath,
    modelEvidencePhase: "setup",
  });
  const conversation = assembly.runtime.createConversation({ title: scenario.definition.run.title });
  const runInput = {
    ...scenario.definition.run.input,
    model: assembly.modelAlias,
  };

  /** 在 Runtime 已提交目标 ToolResult 后制造真实进程退出窗口。 */
  function exitAfterCommittedToolResult(event) {
    if (event.type !== "completed" || event.toolName !== scenario.definition.fault.toolName) return;
    process.exit(scenario.definition.fault.exitCode);
  }

  try {
    await assembly.runtime.runConversation(conversation.id, runInput, {
      onToolEvent: exitAfterCommittedToolResult,
    });
    throw new Error("fault checkpoint was not reached");
  } finally {
    assembly.close();
  }
}

/** 解析 Worker 所需的显式路径、模式和可选模型别名。 */
function parseWorkerArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid worker argument: ${key || "(empty)"}`);
    values.set(key.slice(2), value);
  }
  const scenarioDirectory = values.get("scenario");
  const mode = values.get("mode");
  const databasePath = values.get("database");
  const modelEvidencePath = values.get("model-evidence");
  if (!scenarioDirectory || !mode || !databasePath || !modelEvidencePath) {
    throw new Error("worker requires --scenario, --mode, --database, and --model-evidence");
  }
  return {
    scenarioDirectory: resolve(scenarioDirectory),
    mode,
    databasePath: resolve(databasePath),
    modelEvidencePath: resolve(modelEvidencePath),
    modelAlias: values.get("model") || undefined,
  };
}

main().catch(reportWorkerFailure);

/** 输出不含场景正文和密钥的故障阶段错误，并以普通失败码退出。 */
function reportWorkerFailure(error) {
  console.error(`Runtime scenario worker failed: ${String(error?.message || error).slice(0, 1000)}`);
  process.exitCode = 1;
}

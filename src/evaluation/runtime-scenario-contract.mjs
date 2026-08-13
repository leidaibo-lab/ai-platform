import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const RUNTIME_SCENARIO_SCHEMA_VERSION = "runtime-scenario.v1";
export const RUNTIME_SCENARIO_MODES = Object.freeze(["deterministic", "real-model"]);

const RUN_INPUT_SCHEMA = z
  .object({
    operation: z.literal("conversation.chat"),
    requestId: z.string().min(1),
    clientMessageId: z.string().min(1),
    message: z.string().min(1),
    imageUrls: z.array(z.string()).default([]),
    documentUrls: z.array(z.string()).default([]),
    references: z.array(z.unknown()).default([]),
  })
  .strict();

const TOOL_FIXTURE_SCHEMA = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u),
    title: z.string().min(1),
    description: z.string().min(1),
    effect: z.literal("read"),
    inputSchema: z.record(z.string(), z.unknown()),
    requiredOnStart: z.boolean().default(false),
    result: z.unknown(),
  })
  .strict();

const RUNTIME_SCENARIO_CASE_SCHEMA = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(RUNTIME_SCENARIO_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/u),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    title: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    supportedModes: z.array(z.enum(RUNTIME_SCENARIO_MODES)).min(1),
    prompt: z
      .object({
        version: z.string().min(1),
        system: z.string().min(1),
      })
      .strict(),
    evaluation: z
      .object({
        temperature: z.number().min(0).max(2),
        maxCompletionTokens: z.number().int().positive(),
      })
      .strict(),
    runtime: z
      .object({
        runTimeoutMs: z.number().int().positive(),
        maxToolSteps: z.number().int().min(1).max(8).default(4),
      })
      .strict(),
    run: z
      .object({
        title: z.string().min(1),
        input: RUN_INPUT_SCHEMA,
      })
      .strict(),
    fault: z
      .object({
        type: z.literal("process-exit-after-tool-result"),
        toolName: z.string().min(1),
        exitCode: z.number().int().min(1).max(255),
      })
      .strict(),
    deterministicModel: z
      .object({
        alias: z.string().min(1),
        actualModel: z.string().min(1),
      })
      .strict(),
    tools: z.array(TOOL_FIXTURE_SCHEMA).min(1),
  })
  .strict();

/**
 * @typedef {object} RuntimeScenario
 * @property {string} directory - 场景资产绝对目录。
 * @property {object} definition - 通过 runtime-scenario.v1 校验的 case.json。
 * @property {{decide: Function}} deterministicModel - 按模型可见观察结果决策的脚本模型。
 * @property {{evaluateScenario: Function}} acceptance - 独立场景验收器。
 */

/**
 * 发现并按 ID 排序版本化 Runtime 场景目录。
 *
 * @param {string} scenariosRoot - 包含 schema.json 和场景子目录的根路径。
 * @returns {Promise<string[]>} 场景目录绝对路径。
 */
export async function discoverRuntimeScenarioDirectories(scenariosRoot) {
  const entries = await readdir(scenariosRoot, { withFileTypes: true });
  const directories = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) directories.push(join(scenariosRoot, entry.name));
  }
  directories.sort(comparePaths);
  return directories;
}

/**
 * 加载一个完整场景资产，并校验目录名、固定模型和验收器契约。
 *
 * @param {string} scenarioDirectory - 包含 case.json、deterministic-model.mjs 和 acceptance.mjs 的目录。
 * @returns {Promise<RuntimeScenario>} 可交给通用 Runner 的不可变场景。
 */
export async function loadRuntimeScenario(scenarioDirectory) {
  const definition = RUNTIME_SCENARIO_CASE_SCHEMA.parse(
    await readJsonFile(join(scenarioDirectory, "case.json")),
  );
  if (basename(scenarioDirectory) !== definition.id) {
    throw new Error(`scenario directory must equal case id: ${definition.id}`);
  }
  assertUniqueToolNames(definition.tools);
  assertFaultToolExists(definition);

  const deterministicModel = await importModule(join(scenarioDirectory, "deterministic-model.mjs"));
  const acceptance = await importModule(join(scenarioDirectory, "acceptance.mjs"));
  if (typeof deterministicModel.decide !== "function") {
    throw new TypeError(`${definition.id} deterministic-model.mjs must export decide()`);
  }
  if (typeof acceptance.evaluateScenario !== "function") {
    throw new TypeError(`${definition.id} acceptance.mjs must export evaluateScenario()`);
  }

  return Object.freeze({
    directory: scenarioDirectory,
    definition: Object.freeze(definition),
    deterministicModel,
    acceptance,
  });
}

/** 比较两个场景路径，保证跨平台发现顺序稳定。 */
function comparePaths(left, right) {
  return left.localeCompare(right, "en");
}

/** 读取并解析 UTF-8 JSON 文件，保留原始解析错误位置。 */
async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

/** 使用文件 URL 动态加载场景模块，避免把场景目录加入生产模块解析规则。 */
async function importModule(filePath) {
  return import(pathToFileURL(filePath).href);
}

/** 拒绝同一场景重复声明工具名，避免模型定义和执行器出现歧义。 */
function assertUniqueToolNames(tools) {
  const names = new Set();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`duplicate scenario tool: ${tool.name}`);
    names.add(tool.name);
  }
}

/** 确保故障注入目标属于当前场景声明的工具事实。 */
function assertFaultToolExists(definition) {
  for (const tool of definition.tools) {
    if (tool.name === definition.fault.toolName) return;
  }
  throw new Error(`fault tool is not declared: ${definition.fault.toolName}`);
}

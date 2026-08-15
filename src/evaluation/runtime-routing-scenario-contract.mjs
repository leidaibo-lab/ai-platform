import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

export const RUNTIME_ROUTING_SCENARIO_SCHEMA_VERSION = "runtime-routing-scenario.v1";
export const RUNTIME_ROUTING_MODEL_FIXTURE_VERSION = "runtime-routing-model-fixture.v1";
export const RUNTIME_ROUTING_GOLD_VERSION = "runtime-routing-gold.v1";
export const RUNTIME_ROUTING_SCENARIO_MODES = Object.freeze(["deterministic", "real-model"]);

const OPERATION_SCHEMA = z.enum(["conversation.chat", "image.generate", "image.edit"]);
const IMAGE_OPERATION_SCHEMA = z.enum(["image.generate", "image.edit"]);
const MESSAGE_ROLE_SCHEMA = z.enum(["user", "assistant"]);
const LOGICAL_MESSAGE_REFERENCE_SCHEMA = z
  .object({
    turnId: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/u),
    role: MESSAGE_ROLE_SCHEMA,
  })
  .strict();
const ASSET_TARGET_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fixture-asset"),
      assetId: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("turn-artifact"),
      turnId: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/u),
      index: z.number().int().min(0).default(0),
    })
    .strict(),
]);
const RUN_REFERENCE_SCHEMA = z
  .object({
    type: z.literal("image_asset"),
    source: ASSET_TARGET_SCHEMA,
  })
  .strict();
const RUN_INPUT_SCHEMA = z
  .object({
    operation: z.literal("auto"),
    requestId: z.string().min(1),
    clientMessageId: z.string().min(1),
    message: z.string().min(1),
    imageUrls: z.array(z.string()).default([]),
    documentUrls: z.array(z.string()).default([]),
    references: z.array(RUN_REFERENCE_SCHEMA).default([]),
    imageOptions: z
      .object({
        size: z.enum(["1024x1024", "1536x1024", "1024x1536"]),
      })
      .strict()
      .default({ size: "1024x1024" }),
  })
  .strict();
const CONVERSATION_SCHEMA = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/u),
    title: z.string().min(1),
    assets: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/u),
            mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
            base64: z.string().regex(/^[a-zA-Z0-9+/]+={0,2}$/u),
          })
          .strict(),
      )
      .default([]),
    turns: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/u),
            input: RUN_INPUT_SCHEMA,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const CASE_SCHEMA = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(RUNTIME_ROUTING_SCENARIO_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/u),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    title: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    supportedModes: z.array(z.enum(RUNTIME_ROUTING_SCENARIO_MODES)).min(1),
    classifier: z
      .object({
        promptVersion: z.string().min(1),
        temperature: z.literal(0),
        maxCompletionTokens: z.number().int().positive(),
        confidenceThreshold: z.number().min(0).max(1),
      })
      .strict(),
    runtime: z
      .object({
        runTimeoutMs: z.number().int().positive(),
      })
      .strict(),
    conversations: z.array(CONVERSATION_SCHEMA).min(1),
  })
  .strict();
const MODEL_TURN_ID_SCHEMA = z
  .object({
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
  })
  .strict();
const MODEL_FIXTURE_SCHEMA = z
  .object({
    schemaVersion: z.literal(RUNTIME_ROUTING_MODEL_FIXTURE_VERSION),
    classifierTurns: z
      .array(
        MODEL_TURN_ID_SCHEMA.extend({
          output: z
            .object({
              operation: OPERATION_SCHEMA,
              confidence: z.number().min(0).max(1),
              useActiveImage: z.boolean(),
              relevantMessages: z.array(LOGICAL_MESSAGE_REFERENCE_SCHEMA).max(6),
            })
            .strict(),
        }).strict(),
      )
      .min(1),
    chatTurns: z
      .array(
        MODEL_TURN_ID_SCHEMA.extend({
          content: z.string().min(1),
        }).strict(),
      )
      .min(1),
    imageTurns: z
      .array(
        MODEL_TURN_ID_SCHEMA.extend({
          operation: IMAGE_OPERATION_SCHEMA,
          behavior: z.discriminatedUnion("status", [
            z
              .object({
                status: z.literal("completed"),
                image: z
                  .object({
                    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
                    base64: z.string().regex(/^[a-zA-Z0-9+/]+={0,2}$/u),
                  })
                  .strict(),
              })
              .strict(),
            z
              .object({
                status: z.literal("failed"),
                errorCode: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/u),
              })
              .strict(),
          ]),
        }).strict(),
      )
      .default([]),
  })
  .strict();
const EVIDENCE_GOLD_SCHEMA = z
  .object({
    minimumCount: z.number().int().min(0).max(6),
    requiredAnyOf: z.array(LOGICAL_MESSAGE_REFERENCE_SCHEMA),
  })
  .strict();
const GOLD_SCHEMA = z
  .object({
    schemaVersion: z.literal(RUNTIME_ROUTING_GOLD_VERSION),
    thresholds: z
      .object({
        operationAccuracyMin: z.number().min(0).max(1),
        sourceAssetAccuracyMin: z.number().min(0).max(1),
        evidenceValidityMin: z.number().min(0).max(1),
        activeImageAccuracyMin: z.number().min(0).max(1),
        visualInputAccuracyMin: z.number().min(0).max(1),
        editPromptHistoryAccuracyMin: z.number().min(0).max(1),
        unexpectedImageSideEffectRateMax: z.number().min(0).max(1),
      })
      .strict(),
    turns: z
      .array(
        MODEL_TURN_ID_SCHEMA.extend({
          operation: OPERATION_SCHEMA,
          candidates: z.array(OPERATION_SCHEMA).min(1),
          useActiveImage: z.boolean(),
          artifactCount: z.number().int().min(0),
          editSource: ASSET_TARGET_SCHEMA.nullable(),
          visionSource: ASSET_TARGET_SCHEMA.nullable(),
          activeImage: ASSET_TARGET_SCHEMA.nullable(),
          evidence: EVIDENCE_GOLD_SCHEMA,
          editPromptHistory: z
            .object({
              requiredAll: z.array(LOGICAL_MESSAGE_REFERENCE_SCHEMA).max(6),
            })
            .strict(),
        }).strict(),
      )
      .min(1),
  })
  .strict();

/**
 * @typedef {object} RuntimeRoutingScenario
 * @property {string} directory - 场景资产绝对目录。
 * @property {object} definition - 不含标准答案的会话输入。
 * @property {object} modelFixture - 确定性分类与业务模型行为。
 * @property {object} gold - Runner 不会发送给模型的隐藏标准答案。
 */

/** 发现并稳定排序独立的 Runtime 路由场景目录。 */
export async function discoverRuntimeRoutingScenarioDirectories(scenariosRoot) {
  const entries = await readdir(scenariosRoot, { withFileTypes: true });
  const directories = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) directories.push(join(scenariosRoot, entry.name));
  }
  directories.sort(comparePaths);
  return directories;
}

/**
 * 加载输入、确定性模型行为和隐藏 gold 三份独立资产，并执行跨文件完整性校验。
 *
 * @param {string} scenarioDirectory - 包含 case.json、model-fixture.json 和 gold.json 的目录。
 * @returns {Promise<RuntimeRoutingScenario>} 可交给通用 Runner 的场景。
 */
export async function loadRuntimeRoutingScenario(scenarioDirectory) {
  const definition = CASE_SCHEMA.parse(await readJsonFile(join(scenarioDirectory, "case.json")));
  const modelFixture = MODEL_FIXTURE_SCHEMA.parse(
    await readJsonFile(join(scenarioDirectory, "model-fixture.json")),
  );
  const gold = GOLD_SCHEMA.parse(await readJsonFile(join(scenarioDirectory, "gold.json")));
  if (basename(scenarioDirectory) !== definition.id) {
    throw new Error(`scenario directory must equal case id: ${definition.id}`);
  }
  assertScenarioIntegrity(definition, modelFixture, gold);
  return Object.freeze({
    directory: scenarioDirectory,
    definition: Object.freeze(definition),
    modelFixture: Object.freeze(modelFixture),
    gold: Object.freeze(gold),
  });
}

/** 比较两个路径，确保不同平台上的发现顺序一致。 */
function comparePaths(left, right) {
  return left.localeCompare(right, "en");
}

/** 读取并解析 UTF-8 JSON，保留 JSON 原始错误位置。 */
async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

/** 校验跨文件 ID、覆盖率、唯一性和历史证据只能指向先前轮次。 */
function assertScenarioIntegrity(definition, modelFixture, gold) {
  const turns = buildTurnOrder(definition);
  assertUniqueConversationAssets(definition);
  assertTurnAssetReferences(definition, turns);
  assertExactTurnCoverage("classifier fixture", modelFixture.classifierTurns, turns);
  assertExactTurnCoverage("chat fixture", modelFixture.chatTurns, turns);
  assertUniqueKnownTurnCoverage("image fixture", modelFixture.imageTurns, turns);
  assertExactTurnCoverage("gold", gold.turns, turns);
  assertHistoricalEvidence(modelFixture.classifierTurns, turns);
  assertHistoricalGoldEvidence(gold.turns, turns);
  assertGoldAssetTargets(definition, gold.turns, turns);
}

/** 构造全局唯一的逻辑轮次顺序，并拒绝重复会话或轮次标识。 */
function buildTurnOrder(definition) {
  const order = new Map();
  const conversationIds = new Set();
  let index = 0;
  for (const conversation of definition.conversations) {
    if (conversationIds.has(conversation.id)) throw new Error(`duplicate conversation id: ${conversation.id}`);
    conversationIds.add(conversation.id);
    const turnIds = new Set();
    for (const turn of conversation.turns) {
      if (turnIds.has(turn.id)) throw new Error(`duplicate turn id: ${conversation.id}/${turn.id}`);
      turnIds.add(turn.id);
      const key = toTurnKey(conversation.id, turn.id);
      order.set(key, { index, conversationId: conversation.id, turnId: turn.id });
      index += 1;
    }
  }
  return order;
}

/** 确保每个会话内上传资产标识唯一。 */
function assertUniqueConversationAssets(definition) {
  for (const conversation of definition.conversations) {
    const ids = new Set();
    for (const asset of conversation.assets) {
      if (ids.has(asset.id)) throw new Error(`duplicate fixture asset: ${conversation.id}/${asset.id}`);
      ids.add(asset.id);
    }
  }
}

/** 确保 Run 输入引用的 fixture 或历史产物在当前会话中存在且已经形成。 */
function assertTurnAssetReferences(definition, turns) {
  for (const conversation of definition.conversations) {
    const assetIds = new Set();
    for (const asset of conversation.assets) assetIds.add(asset.id);
    for (const turn of conversation.turns) {
      const current = turns.get(toTurnKey(conversation.id, turn.id));
      for (const reference of turn.input.references) {
        assertAssetTargetExists(reference.source, conversation.id, current.index, assetIds, turns);
      }
    }
  }
}

/** 要求 sidecar 对每个输入轮次恰好声明一次，不允许答案缺失或额外轮次。 */
function assertExactTurnCoverage(label, entries, turns) {
  const covered = new Set();
  for (const entry of entries) {
    const key = toTurnKey(entry.conversationId, entry.turnId);
    if (!turns.has(key)) throw new Error(`${label} references unknown turn: ${key}`);
    if (covered.has(key)) throw new Error(`${label} duplicates turn: ${key}`);
    covered.add(key);
  }
  if (covered.size !== turns.size) throw new Error(`${label} must cover every case turn exactly once`);
}

/** 要求可选 sidecar 条目只引用已知轮次且每轮最多声明一次。 */
function assertUniqueKnownTurnCoverage(label, entries, turns) {
  const covered = new Set();
  for (const entry of entries) {
    const key = toTurnKey(entry.conversationId, entry.turnId);
    if (!turns.has(key)) throw new Error(`${label} references unknown turn: ${key}`);
    if (covered.has(key)) throw new Error(`${label} duplicates turn: ${key}`);
    covered.add(key);
  }
}

/** 拒绝确定性分类器引用当前或未来消息，避免脚本答案穿越会话事实。 */
function assertHistoricalEvidence(classifierTurns, turns) {
  for (const entry of classifierTurns) {
    const current = turns.get(toTurnKey(entry.conversationId, entry.turnId));
    for (const reference of entry.output.relevantMessages) {
      assertPriorMessageReference(reference, current, turns, "classifier fixture");
    }
  }
}

/** 拒绝 gold 要求当前或未来来源，保证隐藏探针只验证模型可见事实。 */
function assertHistoricalGoldEvidence(goldTurns, turns) {
  for (const entry of goldTurns) {
    const current = turns.get(toTurnKey(entry.conversationId, entry.turnId));
    for (const reference of entry.evidence.requiredAnyOf) {
      assertPriorMessageReference(reference, current, turns, "gold evidence");
    }
    for (const reference of entry.editPromptHistory.requiredAll) {
      assertPriorMessageReference(reference, current, turns, "gold edit prompt history");
    }
    if (entry.editPromptHistory.requiredAll.length > 0 && entry.operation !== "image.edit") {
      throw new Error(`gold edit prompt history requires image.edit: ${entry.conversationId}/${entry.turnId}`);
    }
    if (entry.visionSource && entry.operation !== "conversation.chat") {
      throw new Error(`gold vision source requires conversation.chat: ${entry.conversationId}/${entry.turnId}`);
    }
  }
}

/** 校验 gold 中编辑源和活动图片目标来自当前会话已有资产或先前产物。 */
function assertGoldAssetTargets(definition, goldTurns, turns) {
  for (const conversation of definition.conversations) {
    const assetIds = new Set();
    for (const asset of conversation.assets) assetIds.add(asset.id);
    for (const entry of goldTurns) {
      if (entry.conversationId !== conversation.id) continue;
      const current = turns.get(toTurnKey(entry.conversationId, entry.turnId));
      if (entry.editSource) {
        assertAssetTargetExists(entry.editSource, conversation.id, current.index, assetIds, turns);
      }
      if (entry.visionSource) {
        assertAssetTargetExists(entry.visionSource, conversation.id, current.index, assetIds, turns);
      }
      if (entry.activeImage) {
        assertAssetTargetExists(entry.activeImage, conversation.id, current.index + 1, assetIds, turns);
      }
    }
  }
}

/** 校验逻辑消息引用属于同一会话的严格历史轮次。 */
function assertPriorMessageReference(reference, current, turns, label) {
  const target = turns.get(toTurnKey(current.conversationId, reference.turnId));
  if (!target || target.index >= current.index) {
    throw new Error(`${label} must reference an earlier turn in ${current.conversationId}`);
  }
}

/** 校验逻辑资产目标存在，并在引用当前产物时满足时间顺序。 */
function assertAssetTargetExists(target, conversationId, beforeIndex, assetIds, turns) {
  if (target.kind === "fixture-asset") {
    if (!assetIds.has(target.assetId)) {
      throw new Error(`unknown fixture asset: ${conversationId}/${target.assetId}`);
    }
    return;
  }
  const targetTurn = turns.get(toTurnKey(conversationId, target.turnId));
  if (!targetTurn || targetTurn.index >= beforeIndex) {
    throw new Error(`turn artifact must already exist: ${conversationId}/${target.turnId}`);
  }
}

/** 将会话和轮次标识组合为不暴露正文的稳定查找键。 */
function toTurnKey(conversationId, turnId) {
  return `${conversationId}/${turnId}`;
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateMessagesTokens } from "../../../../../src/runtime/context-budget.mjs";
import { createTestRuntime, run } from "../../../../../scripts/test-runtime.mjs";

const skillDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultFixturePath = join(skillDirectory, "assets", "fixtures", "message-queue-correction-100.json");

/** 解析 CLI 参数并返回待执行 fixture 路径。 */
function parseArguments(argv) {
  let fixturePath = defaultFixturePath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--fixture" || !argv[index + 1]) {
      throw new Error(`Unsupported argument: ${argument}`);
    }
    fixturePath = isAbsolute(argv[index + 1]) ? argv[index + 1] : resolve(argv[index + 1]);
    index += 1;
  }
  return { fixturePath };
}

/** 读取并校验 fixture 的核心执行字段。 */
async function loadFixture(fixturePath) {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  validateFixture(fixture);
  return fixture;
}

/** 阻止字段不完整的 fixture 进入长轮次执行。 */
function validateFixture(fixture) {
  if (!fixture?.id || !fixture?.title) throw new Error("Fixture id and title are required");
  if (!Number.isInteger(fixture.turnCount) || fixture.turnCount <= 0) throw new Error("turnCount must be a positive integer");
  if (!Number.isInteger(fixture.checkpointEvery) || fixture.checkpointEvery <= 0) {
    throw new Error("checkpointEvery must be a positive integer");
  }
  if (!String(fixture.defaultTurnTemplate || "").includes("{{turn}}")) {
    throw new Error("defaultTurnTemplate must contain {{turn}}");
  }
  if (!Array.isArray(fixture.events) || !fixture.probe?.message || !fixture.probe?.expectedAnswer || !fixture.probe?.memory) {
    throw new Error("Fixture events and probe are required");
  }
  if (!Array.isArray(fixture.metrics) || fixture.metrics.length === 0) throw new Error("Fixture metrics are required");
}

/** 创建由 fixture MemoryDelta 和隐藏探针驱动的确定性 Gateway。 */
function createFixtureGateway(fixture) {
  return {
    model: `fixture:${fixture.id}`,
    /** 返回与本地估算一致的 token 数。 */
    async countTokens({ messages }) {
      return { tokens: estimateMessagesTokens(messages), source: "fixture", model: this.model };
    },
    /** 对提取请求应用 fixture delta，对隐藏探针返回 fixture 标准答案。 */
    async chatCompletions({ messages, responseFormat }) {
      if (responseFormat) return buildFixtureMemoryResponse(messages, fixture, this.model);
      const question = String(messages.at(-1)?.content || "");
      const memoryText = messages.filter(isSystemMessage).map(getMessageContent).join("\n");
      const hasExpectedMemory = memoryText.includes(buildMemoryMarker(fixture.probe.memory));
      const content = question === fixture.probe.message
        ? (hasExpectedMemory ? fixture.probe.expectedAnswer : "无法确认")
        : "已收到";
      return {
        model: this.model,
        usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 8 },
        choices: [{ message: { content } }],
      };
    },
  };
}

/** 判断模型消息是否为系统上下文。 */
function isSystemMessage(message) {
  return message.role === "system";
}

/** 返回模型消息纯文本内容。 */
function getMessageContent(message) {
  return String(message.content || "");
}

/** 将 fixture 记忆选择器转换为 Planner 的稳定文本标记。 */
function buildMemoryMarker(memory) {
  return `${memory.entity}.${memory.key}=${memory.value}`;
}

/** 将当前压缩批次映射为 fixture 声明的 MemoryDelta。 */
function buildFixtureMemoryResponse(messages, fixture, model) {
  const prompt = String(messages.at(-1)?.content || "");
  const marker = "新增消息：";
  const sourceMessages = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length).trim());
  const delta = buildFixtureDelta(sourceMessages, fixture);
  return {
    model,
    usage: { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: 80 },
    choices: [{ message: { content: JSON.stringify(delta) } }],
  };
}

/** 合并本批来源消息对应的 upsert、supersede 和 Episode。 */
function buildFixtureDelta(sourceMessages, fixture) {
  const eventsByMessage = new Map(fixture.events.map(indexEventByMessage));
  const upserts = [];
  const supersedes = [];
  for (const message of sourceMessages) {
    const event = eventsByMessage.get(String(message.content || ""));
    for (const item of event?.memoryDelta?.upserts || []) {
      upserts.push({ ...item, sourceMessageIds: [message.id] });
    }
    for (const item of event?.memoryDelta?.supersedes || []) {
      supersedes.push({ ...item, sourceMessageIds: [message.id] });
    }
  }
  return {
    upserts,
    supersedes,
    episode: {
      topic: fixture.title,
      summary: sourceMessages.map(getSourceContent).join("；").slice(0, 240),
      sourceMessageIds: sourceMessages.map(getSourceId),
    },
  };
}

/** 将 fixture event 转换为按消息文本索引的 Map 条目。 */
function indexEventByMessage(event) {
  return [event.message, event];
}

/** 返回提取来源消息正文。 */
function getSourceContent(message) {
  return String(message.content || "");
}

/** 返回提取来源消息 ID。 */
function getSourceId(message) {
  return message.id;
}

/** 返回指定轮次的事件消息或填充默认噪声模板。 */
function buildTurnMessage(fixture, turn) {
  const event = fixture.events.find(candidate => candidate.turn === turn);
  return event?.message || fixture.defaultTurnTemplate.replaceAll("{{turn}}", String(turn));
}

/** 运行一个 fixture 并输出动态指标与 checkpoint 时间线。 */
async function runEvaluation(fixture, fixturePath) {
  const gatewayClient = createFixtureGateway(fixture);
  const runtimeFixture = createTestRuntime({ gatewayClient });
  const checkpoints = [];
  try {
    const conversation = runtimeFixture.runtime.createConversation({ title: fixture.title });
    for (let turn = 1; turn <= fixture.turnCount; turn += 1) {
      await run(runtimeFixture.runtime, conversation.id, turn, buildTurnMessage(fixture, turn));
      if (turn % fixture.checkpointEvery === 0) {
        const result = await runtimeFixture.memoryManager.compactIfNeeded(conversation.id, { force: true });
        checkpoints.push({ turn, status: result.status, memoryVersion: result.memoryVersion || null });
      }
    }

    const probe = await run(runtimeFixture.runtime, conversation.id, fixture.turnCount + 1, fixture.probe.message);
    const detail = runtimeFixture.runtime.getConversation(conversation.id);
    const activeItems = detail.memory.items.filter(isActive);
    const metricResults = Object.fromEntries(
      fixture.metrics.map(metric => [metric.name, evaluateMetric(metric, { activeItems, probe })]),
    );
    const passedMetrics = Object.values(metricResults).filter(Boolean).length;
    const totalMetrics = Object.keys(metricResults).length;
    const expectedCheckpoints = Math.floor(fixture.turnCount / fixture.checkpointEvery);

    assert.equal(checkpoints.length, expectedCheckpoints);
    assert.ok(checkpoints.every(isCompactedCheckpoint));
    assert.equal(passedMetrics, totalMetrics);

    const report = {
      fixture: fixture.id,
      turns: fixture.turnCount,
      checkpoints: checkpoints.length,
      finalMemoryVersion: detail.memory.version,
      summarizedThroughSeq: detail.memory.summarizedThroughSeq,
      ...Object.fromEntries(Object.entries(metricResults).map(formatMetricEntry)),
      metricScore: `${passedMetrics}/${totalMetrics}`,
      accuracy: `${((passedMetrics / totalMetrics) * 100).toFixed(1)}%`,
    };
    console.log(`Fixture: ${fixturePath}`);
    console.table([report]);
    console.log("\nCheckpoint timeline:");
    console.table(checkpoints);
  } finally {
    runtimeFixture.store.close();
  }
}

/** 判断记忆项是否 active。 */
function isActive(item) {
  return item.status === "active";
}

/** 根据 fixture 指标类型执行通用判分。 */
function evaluateMetric(metric, state) {
  if (metric.type === "probe-and-memory") {
    return state.probe.content === metric.expectedAnswer && state.activeItems.some(item => matchesMemory(item, metric.memory));
  }
  if (metric.type === "memory") return state.activeItems.some(item => matchesMemory(item, metric.memory));
  if (metric.type === "memory-absent") return !state.activeItems.some(item => matchesMemory(item, metric.memory));
  if (metric.type === "all-active-sources") return state.activeItems.length > 0 && state.activeItems.every(hasSources);
  throw new Error(`Unsupported metric type: ${metric.type}`);
}

/** 判断 active 记忆是否满足 fixture 声明的字段子集。 */
function matchesMemory(item, expected) {
  return Object.entries(expected || {}).every(([key, value]) => item[key] === value);
}

/** 判断记忆项是否保留至少一个原始消息来源。 */
function hasSources(item) {
  return Array.isArray(item.sourceMessageIds) && item.sourceMessageIds.length > 0;
}

/** 判断 checkpoint 是否成功完成压缩。 */
function isCompactedCheckpoint(checkpoint) {
  return checkpoint.status === "compacted";
}

/** 将单项布尔指标转换为报告字段。 */
function formatMetricEntry([name, value]) {
  return [name, value ? "PASS" : "FAIL"];
}

/** 加载 CLI 指定 fixture 并执行评测。 */
async function main() {
  const { fixturePath } = parseArguments(process.argv.slice(2));
  const fixture = await loadFixture(fixturePath);
  await runEvaluation(fixture, fixturePath);
}

main().catch(reportFailure);

/** 输出评测失败并设置非零退出码。 */
function reportFailure(error) {
  console.error(error);
  process.exitCode = 1;
}

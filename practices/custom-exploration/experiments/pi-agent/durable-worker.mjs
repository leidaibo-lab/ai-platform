// pi-durable 自有 SQLite 的隔离实验；不接入平台 ConversationStore 或正式 Runtime。
import { appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineExtension, defineTool, defineTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/**
 * 运行真实进程故障窗口：已提交工具结果、工具中断、或自定义 task checkpoint。
 * 参数目录只能由测试 runner 创建；不读取平台业务数据库或真实凭据。
 */
async function main() {
  const [directory, scenario, phase] = process.argv.slice(2);
  const context = BACKGROUND_CONTEXT;
  const registry = createRegistry();
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const effectFile = join(directory, "effects.txt");
  const tool = defineTool({ name: "poc_effect", description: "隔离测试副作用", parameters: Type.Object({}),
    ...(scenario === "safe-tool" ? { replay: "safe" } : {}),
    /** 用文件计数模拟已发生的外部操作；该操作不与 pi SQLite 事务原子提交。 */
    async execute() {
      appendFileSync(effectFile, "effect\n");
      if (phase === "crash" && scenario !== "completed-tool") process.exit(74);
      return { output: [{ type: "text", text: "effect committed" }] };
    },
  });
  const checkpointTask = defineTask({ name: "poc.checkpoint", version: 1,
    /** 从显式的第一阶段开始，状态由 pi-durable 存储。 */
    initial: () => ({ phase: "first" }),
    phases: {
      /** 先提交第二阶段 checkpoint，再制造真正进程退出。 */
      async first(task, runtime, taskContext) {
        appendFileSync(effectFile, "first\n");
        await runtime.commit(
          /** 持久化下一阶段，避免重启后重复第一阶段。 */
          () => ({ status: "running", checkpoint: { phase: "second" } }), taskContext);
        if (phase === "crash") process.exit(75);
      },
      /** 恢复从第二阶段继续；仍需业务自行保证阶段内副作用幂等。 */
      async second(task, runtime, taskContext) {
        appendFileSync(effectFile, "second\n");
        await runtime.commit(
          /** 将任务结果与 terminal 状态原子提交。 */
          () => ({ status: "terminal", outcome: { status: "completed", result: "done" } }), taskContext);
      },
    },
    /** 中止只提交任务终态，不假装已经补偿文件副作用。 */
    async abort(task, runtime, taskContext) {
      await runtime.commit(
        /** 保存可观察的中止事实。 */
        () => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
    },
  });
  registry.install(defineExtension({ name: "poc", tools: [tool], tasks: [checkpointTask] }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "durable.sqlite")), { models, registry }, context);
  try {
    const model = faux.getModel();
    const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    if (scenario === "checkpoint") {
      if (phase === "crash") {
        const taskId = await root.commit(
          /** 原子建立持久任务，将其身份写入独立故障证据。 */
          (tx) => tx.createTask(checkpointTask, {}, { ownership: { kind: "conversation" } }), context);
        writeFileSync(join(directory, "task-id.txt"), JSON.stringify(taskId));
        await harness.waitForTask(taskId, context);
      } else {
        const settled = await harness.waitForTask(JSON.parse(readFileSync(join(directory, "task-id.txt"), "utf8")), context);
        console.log(JSON.stringify({ outcome: settled.state.outcome }));
      }
      return;
    }
    let recoveredMessages = null;
    /** 首次请求调用工具；后续请求只总结存储中恢复的工具结果。 */
    function scriptedResponse(transcript) {
      const hasResult = transcript.messages.some(isToolResult);
      if (phase === "crash" && scenario === "completed-tool" && hasResult) process.exit(76);
      if (!hasResult) return fauxAssistantMessage([fauxToolCall("poc_effect", {}, { id: "poc-call" })], { stopReason: "toolUse" });
      recoveredMessages = transcript.messages;
      return fauxAssistantMessage("done");
    }
    faux.setResponses([scriptedResponse, scriptedResponse, scriptedResponse]);
    const submission = await root.submit({ type: "input", content: "执行隔离测试", requestId: "durable-request" }, context);
    const settled = await submission.wait(context);
    const replay = await root.submit({ type: "input", content: "执行隔离测试", requestId: "durable-request" }, context);
    const entries = await root.entries({}, 100, undefined, context);
    console.log(JSON.stringify({ status: settled.status, replaySame: replay.id === submission.id,
      modelCalls: faux.state.callCount, recoveredMessages, entries: entries.items }));
  } finally { await harness.close(context); }
}
/** 检测模型上下文中已经恢复的工具事实。 */
function isToolResult(message) { return message.role === "toolResult"; }
/** 只输出假场景的诊断；不会捕获或打印真实 key。 */
function reportFailure(error) { console.error(error); process.exitCode = 1; }
main().catch(reportFailure);

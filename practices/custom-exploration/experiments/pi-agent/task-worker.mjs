// 原生父子任务 PoC：任务事实归 Pi SQLite；文件日志仅观察外部效果，不接正式 Runtime。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/** @typedef {{phase: string, children?: number[]}} Checkpoint JSON checkpoint，由 Pi 持有；子任务身份跨进程保持。 */
/** 用文件记录阶段边界；该文件不是任务事实源，也不提供外部 exactly-once。 */
function record(directory, event) { appendFileSync(join(directory, "events.txt"), `${event}\n`); }
/** 提交任务结果，业务失败采用显式 failed receipt。 */
async function finish(runtime, context, outcome) {
  await runtime.commit(
    // 原子提交 Pi 内部终态。
    () => ({ status: "terminal", outcome }), context);
}
/** 构建原生任务定义并执行指定故障场景，依赖注入仅用于隔离测试。 */
async function main() {
  const [directory, scenario, mode] = process.argv.slice(2);
  const context = BACKGROUND_CONTEXT;
  let markReady;
  // 显式阶段门闩让外部调用方取消，避免任务在自身 invocation 内等待自身中止。
  const ready = new Promise((resolve) => { markReady = resolve; });
  const child = defineTask({ name: "poc.child", version: 1,
    // 每个子任务独立拥有可恢复阶段。
    initial: () => ({ phase: "run" }),
    phases: {
      /** 长等待可被取消；恢复案例先等待父任务完成故障退出。 */
      async run(task, runtime, ctx) {
        if (mode === "crash" || ["abort", "background"].includes(scenario) || (scenario === "failFast" && task.input.name === "b")) {
          await runtime.sleep(runtime.now() + 60000, ctx);
        }
        record(directory, `child:${task.input.name}`);
        await finish(runtime, ctx, task.input.fail
          ? { status: "failed", error: { message: "expected rejection" } }
          : { status: "completed", result: task.input.name });
      },
    },
    /** 记录 bottom-up 清理顺序，不宣称补偿任意外部操作。 */
    async abort(task, runtime, ctx) {
      record(directory, `abort:${task.input.name}`);
      await finish(runtime, ctx, { status: "aborted" });
    },
  });
  const parent = defineTask({ name: "poc.parent", version: 1,
    // 创建 children 只在初始阶段执行。
    initial: () => ({ phase: "spawn" }),
    phases: {
      /** 在同一事务建立 children 与 waiting checkpoint，消除重启重复创建窗口。 */
      async spawn(task, runtime, ctx) {
        await runtime.commit(
          // 子任务所有权和等待边界原子持久化。
          async (tx) => {
            const children = [];
            for (const name of ["a", "b"]) children.push(await tx.createTask(child,
              { name, fail: name === "a" && ["allSettled", "failFast"].includes(scenario) },
              { ownership: scenario === "background" && name === "b"
                  ? { kind: "conversation" } : { kind: "task", taskId: task.id },
                ...(scenario === "background" && name === "b" ? { background: true } : {}) }));
            writeFileSync(join(directory, "children.json"), JSON.stringify(children));
            return { status: "waiting", checkpoint: { phase: "join", children }, on: scenario === "background" ? [children[0]] : children,
              policy: scenario === "failFast" ? "failFast" : "allSettled" };
          }, ctx);
        record(directory, "parent:waiting");
        if (mode === "crash") process.exit(77);
        markReady();
      },
      /** Join 读取已持久化 receipt，显式保留失败信息供平台验收。 */
      async join(task, runtime, ctx) {
        const outcomes = await runtime.outcomes(task.state.checkpoint.children, ctx);
        await finish(runtime, ctx, { status: "completed", result: outcomes });
      },
    },
    /** 父任务的清理必须在普通 owned children 中止完成后运行。 */
    async abort(task, runtime, ctx) {
      record(directory, "abort:parent");
      await finish(runtime, ctx, { status: "aborted" });
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "poc.tasks", tasks: [parent, child] }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "tasks.sqlite")),
    { registry, models: createModels(),
      // 公开假场景内部 fault，避免任务故障被等待门闩掩盖。
      onReport: (error) => console.error(error) }, context);
  try {
    const root = await harness.root(context);
    let id;
    if (mode === "recover") id = JSON.parse(readFileSync(join(directory, "parent.json"), "utf8"));
    else {
      id = await root.commit(
        // 只由首次进程创建根任务；恢复进程复用身份。
        (tx) => tx.createTask(parent, {}, { ownership: { kind: "conversation" } }), context);
      writeFileSync(join(directory, "parent.json"), JSON.stringify(id));
    }
    if (["abort", "background"].includes(scenario)) {
      harness.resume();
      await Promise.race([ready, harness.waitForTask(id, context).then(
        // 如果启动阶段先失败，立即暴露 receipt，而非悬空等待。
        (settled) => { throw new Error(JSON.stringify(settled.state.outcome)); })]);
      await harness.abortTask(id, context);
    }
    const receipt = await harness.waitForTask(id, context);
    const ids = JSON.parse(readFileSync(join(directory, "children.json"), "utf8"));
    let backgroundSurvived = false;
    if (scenario === "background") {
      backgroundSurvived = (await harness.getTask(ids[1], context)).state.status !== "terminal";
      await root.abort(context, { background: true });
    }
    const children = [];
    for (const childId of ids) children.push((await harness.waitForTask(childId, context)).state.outcome);
    console.log(JSON.stringify({ id, outcome: receipt.state.outcome, children, ids, backgroundSurvived }));
  } finally { await harness.close(context); }
}
/** 将假场景错误交给测试 runner，避免错误静默通过。 */
function report(error) { console.error(error); process.exitCode = 1; }
main().catch(report);

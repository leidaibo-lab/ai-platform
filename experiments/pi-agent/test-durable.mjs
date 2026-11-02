import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

for (const scenario of ["completed-tool", "unsafe-tool", "safe-tool", "checkpoint"]) {
  // 在真正的崩溃/恢复子进程间观察 SQLite checkpoint 和独立外部副作用计数。
  test(`pi-durable: ${scenario} process crash boundary`, { timeout: 12000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-durable-poc-"));
    try {
      const crash = runWorker(directory, scenario, "crash");
      const expectedCode = scenario === "completed-tool" ? 76 : scenario === "checkpoint" ? 75 : 74;
      assert.equal(crash.status, expectedCode, crash.stderr);
      const recovered = runWorker(directory, scenario, "recover");
      assert.equal(recovered.status, 0, recovered.stderr);
      const evidence = JSON.parse(recovered.stdout);
      const effects = readFileSync(join(directory, "effects.txt"), "utf8");
      if (scenario === "checkpoint") {
        assert.equal(evidence.outcome.status, "completed");
        assert.equal(effects, "first\nsecond\n");
      } else {
        assert.equal(evidence.status, "done");
        assert.equal(evidence.replaySame, true);
        assert.equal(effects, scenario === "safe-tool" ? "effect\neffect\n" : "effect\n");
        const toolResult = evidence.recoveredMessages.find(isToolResult);
        assert.equal(toolResult.isError, scenario === "unsafe-tool");
        if (scenario === "unsafe-tool") assert.ok(JSON.stringify(toolResult).includes("interrupted"));
        assert.equal(evidence.modelCalls, 1);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

// 文档声明单进程拥有存储；验证两个独立 Harness 都能打开，不能把 SQLite 写事务误当 owner fencing。
test("pi-durable: storage open does not grant exclusive harness ownership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-owner-"));
  const harnesses = [];
  try {
    for (let index = 0; index < 2; index += 1) harnesses.push(await Harness.open(
      await openNodeSqliteStorage(join(directory, "durable.sqlite")),
      { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT));
    assert.equal(harnesses.length, 2);
  } finally {
    for (const harness of harnesses) await harness.close(BACKGROUND_CONTEXT);
    rmSync(directory, { recursive: true, force: true });
  }
});

// 将业务状态置于 Pi 事务中可得到原子回滚，但这不覆盖外部 HTTP/文件系统副作用。
test("pi-durable: document mutation rolls back with failed commit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-rollback-"));
  const state = defineDoc({ kind: "poc.state", version: 1, scope: "conversation", history: "latest", fork: "initial",
    /** 给新的会话文档提供独立初值，避免可变对象共享。 */
    initial: () => ({ count: 0 }) });
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "durable.sqlite")),
    { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    await root.commit(
      /** 在独立事务中建立业务文档。 */
      async (tx) => { (await tx.doc(state, root.id)).count = 1; }, BACKGROUND_CONTEXT);
    await assert.rejects(root.commit(
      /** 制造事务中途异常，验证不会提交部分文档状态。 */
      async (tx) => { (await tx.doc(state, root.id)).count = 2; throw new Error("poc rollback"); }, BACKGROUND_CONTEXT));
    assert.equal((await harness.snapshot(state, root.id, BACKGROUND_CONTEXT)).count, 1);
  } finally { await harness.close(BACKGROUND_CONTEXT); rmSync(directory, { recursive: true, force: true }); }
});

/** 用当前 Node 24 启动 Worker，限制超时并保存失败码与诊断。 */
function runWorker(directory, scenario, phase) {
  return spawnSync(process.execPath, [new URL("./durable-worker.mjs", import.meta.url).pathname, directory, scenario, phase],
    { encoding: "utf8", timeout: 5000 });
}
/** 读取恢复上下文中的工具消息，而不靠最终自然语言回答推断事实。 */
function isToolResult(message) { return message.role === "toolResult"; }

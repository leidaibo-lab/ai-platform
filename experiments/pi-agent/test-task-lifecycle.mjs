import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** 在独立真实进程启动任务，超时作为不合作取消或死锁的失败证据。 */
function run(directory, scenario, mode) {
  return spawnSync(process.execPath, [new URL("./task-worker.mjs", import.meta.url).pathname, directory, scenario, mode],
    { encoding: "utf8", timeout: 5000 });
}
for (const scenario of ["restart", "allSettled", "failFast", "abort", "background"]) {
  // 验证真实父子任务生命周期，独立目录保证案例无历史状态污染。
  test(`pi-durable task ownership: ${scenario}`, { timeout: 12000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-task-poc-"));
    try {
      let originalIds;
      if (scenario === "restart") {
        const crash = run(directory, scenario, "crash");
        assert.equal(crash.status, 77, crash.stderr);
        originalIds = JSON.parse(readFileSync(join(directory, "children.json"), "utf8"));
      }
      const result = run(directory, scenario, scenario === "restart" ? "recover" : "run");
      assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
      const evidence = JSON.parse(result.stdout);
      const events = readFileSync(join(directory, "events.txt"), "utf8").trim().split("\n");
      if (["restart", "allSettled", "failFast"].includes(scenario)) assert.equal(evidence.outcome.status, "completed");
      if (scenario === "restart") {
        assert.deepEqual(evidence.ids, originalIds);
        assert.deepEqual(evidence.children.map(outcomeStatus), ["completed", "completed"]);
        assert.equal(events.filter(isWaiting).length, 1);
        assert.equal(events.filter(isChild).length, 2);
      } else if (scenario === "allSettled") {
        assert.deepEqual(evidence.children.map(outcomeStatus), ["failed", "completed"]);
        assert.deepEqual(evidence.outcome.result.map(outcomeStatus), ["failed", "completed"]);
      } else if (scenario === "failFast") {
        assert.deepEqual(evidence.children.map(outcomeStatus), ["failed", "aborted"]);
        assert.ok(events.includes("abort:b"));
      } else {
        assert.equal(evidence.outcome.status, "aborted");
        assert.deepEqual(evidence.children.map(outcomeStatus), ["aborted", "aborted"]);
        if (scenario === "background") {
          assert.equal(evidence.backgroundSurvived, true);
          assert.ok(events.indexOf("abort:b") > events.indexOf("abort:parent"));
        } else assert.equal(events.at(-1), "abort:parent");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
/** 提取 durable receipt 状态，而不依赖自然语言输出。 */
function outcomeStatus(outcome) { return outcome.status; }
/** 计数已提交父任务等待边界。 */
function isWaiting(event) { return event === "parent:waiting"; }
/** 计数模拟子任务效果，检测恢复重复执行。 */
function isChild(event) { return event.startsWith("child:"); }

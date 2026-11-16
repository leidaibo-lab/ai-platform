import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { createRunEventSink } from "../../src/runtime/run-event-sink.mjs";
import { createFixture, ANSWER } from "./fixture.mjs";

for (const engine of ["ai-sdk", "pi"]) {
  // 验证两套 SDK 都经假 LiteLLM 协议执行相同 Runtime，工具事实仍由原 Store 拥有。
  test(`${engine}: weather, accepted facts and idempotent replay`, async () => {
    const fixture = createFixture({ engine });
    try {
      const conversation = fixture.runtime.createConversation();
      const input = runInput();
      const result = await fixture.runtime.runConversation(conversation.id, input);
      assert.equal(result.content, ANSWER);
      assert.equal(result.acceptance.status, "accepted");
      assert.equal(fixture.getConnectorCalls(), 1);
      assert.equal(fixture.requests.length, 2);
      assert.equal(fixture.requests[0].body.tool_choice.function.name, "get_weather");
      assert.equal(fixture.requests[0].authorization, "Bearer poc-fake-key");
      const replay = await fixture.runtime.runConversation(conversation.id, input);
      assert.equal(replay.replayed, true);
      assert.equal(fixture.requests.length, 2);
      assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 2);
    } finally { fixture.close(); }
  });

  // 验证普通对话不开放天气工具，文本通过既有生命周期端口交付。
  test(`${engine}: plain streaming without tool exposure`, async () => {
    const fixture = createFixture({ engine, scenario: "plain" });
    const events = [];
    /** 收集宿主流事件；不作为数据库事实源。 */
    function collect(event) { events.push(event); }
    try {
      const conversation = fixture.runtime.createConversation();
      const result = await fixture.runtime.runConversation(conversation.id, runInput("你好"), {
        streamText: true, eventSink: createRunEventSink({ subscribers: [collect] }) });
      assert.equal(result.content, "你好");
      assert.equal(fixture.getConnectorCalls(), 0);
      assert.equal(fixture.requests[0].body.tools?.length || 0, 0);
      assert.ok(events.some(isTextDelta));
    } finally { fixture.close(); }
  });

  // 验证工具前允许平台重试，SDK 本身不得吞掉失败证据。
  test(`${engine}: pre-tool 503 uses platform retry evidence`, async () => {
    const fixture = createFixture({ engine, scenario: "pre-tool-failure" });
    try {
      const conversation = fixture.runtime.createConversation();
      const result = await fixture.runtime.runConversation(conversation.id, runInput());
      assert.equal(result.resilience.attemptCount, 2);
      assert.equal(fixture.requests.length, 3);
      assert.equal(fixture.getConnectorCalls(), 1);
    } finally { fixture.close(); }
  });

  // 验证工具后不重放 Agent，而是利用已提交 ToolResult 做无工具恢复。
  test(`${engine}: post-tool 503 recovers without connector replay`, async () => {
    const fixture = createFixture({ engine, scenario: "post-tool-failure" });
    try {
      const conversation = fixture.runtime.createConversation();
      const result = await fixture.runtime.runConversation(conversation.id, runInput());
      assert.equal(result.acceptance.status, "accepted");
      assert.equal(result.resilience.recovered, true);
      assert.equal(result.resilience.attempts[0].stopReason, "retry-boundary-crossed");
      assert.equal(fixture.requests.length, 3);
      assert.equal(fixture.requests[2].body.tools?.length || 0, 0);
      assert.equal(fixture.getConnectorCalls(), 1);
      assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 2);
      assert.equal(JSON.stringify(result).includes("poc-sensitive-provider-text"), false);
    } finally { fixture.close(); }
  });

  // 验证未知工具与非法参数不会抵达实际 Connector。
  for (const scenario of ["invalid-args", "unknown-tool"]) {
    test(`${engine}: ${scenario} cannot execute connector`, async () => {
      const fixture = createFixture({ engine, scenario });
      try {
        const conversation = fixture.runtime.createConversation();
        await assert.rejects(fixture.runtime.runConversation(conversation.id, runInput()));
        assert.equal(fixture.getConnectorCalls(), 0);
        assert.notEqual(fixture.runtime.getConversation(conversation.id).latestRun.status, "completed");
      } finally { fixture.close(); }
    });
  }

  // 验证模型编造天气事实会被原平台验收拒绝，并且候选不进入流交付。
  test(`${engine}: wrong weather facts rejected before delivery`, async () => {
    const fixture = createFixture({ engine, scenario: "wrong-facts" });
    const events = [];
    /** 收集用于检查未验收候选的交付事件。 */
    function collect(event) { events.push(event); }
    try {
      const conversation = fixture.runtime.createConversation();
      await assert.rejects(fixture.runtime.runConversation(conversation.id, runInput(), {
        streamText: true, eventSink: createRunEventSink({ subscribers: [collect] }) }));
      assert.equal(events.filter(isTextDelta).length, 0);
      assert.equal(fixture.runtime.getConversation(conversation.id).latestRun.acceptance.status, "rejected");
    } finally { fixture.close(); }
  });

  // 验证显式取消正在等待 provider 的调用，不执行工具、不提交成功。
  test(`${engine}: cancellation settles without tool execution`, async () => {
    const fixture = createFixture({ engine, scenario: "cancel" });
    const controller = new AbortController();
    try {
      const conversation = fixture.runtime.createConversation();
      const pending = fixture.runtime.runConversation(conversation.id, runInput(), { abortSignal: controller.signal });
      // 等待已进入 provider 的确定性条件，最多两秒，避免固定 sleep 掩盖竞态。
      const deadline = Date.now() + 2000;
      while (fixture.requests.length === 0 && Date.now() < deadline) await new Promise(setImmediate);
      assert.equal(fixture.requests.length, 1);
      controller.abort();
      const cancelled = await pending;
      assert.equal(cancelled.cancelled, true);
      assert.equal(fixture.getConnectorCalls(), 0);
      assert.notEqual(fixture.runtime.getConversation(conversation.id).latestRun.status, "completed");
    } finally { fixture.close(); }
  });

  // 验证步骤上限阻断无穷工具调用；两引擎可以有不同的超限终态，但都必须有界。
  test(`${engine}: repeated tool requests remain bounded`, async () => {
    const fixture = createFixture({ engine, scenario: "loop", maxSteps: 2 });
    try {
      const conversation = fixture.runtime.createConversation();
      try { await fixture.runtime.runConversation(conversation.id, runInput()); } catch { /* 有界失败是允许结果。 */ }
      assert.ok(fixture.requests.length <= 3);
      assert.ok(fixture.getConnectorCalls() <= 2);
    } finally { fixture.close(); }
  });

  // 验证混合 PoC 的动态 Output.object 仍由现有 AI SDK 处理，明确不算 Pi 原生能力。
  test(`${engine}: structured output stays validated by AI SDK`, async () => {
    for (const scenario of ["structured", "invalid-structured"]) {
      const fixture = createFixture({ engine, scenario });
      try {
        const pending = fixture.gatewayClient.chatCompletions({ messages: [{ role: "user", content: "返回数值" }],
          outputSchema: { name: "poc", schema: z.object({ value: z.number() }) } });
        if (scenario === "structured") assert.deepEqual((await pending).output, { value: 26 });
        else await assert.rejects(pending);
      } finally { fixture.close(); }
    }
  });

  // 在两个真实 Node 子进程中验证原平台持久化恢复；Pi 自身不承担 checkpoint。
  test(`${engine}: actual process crash and restart preserves tool fact`, { timeout: 15000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-poc-"));
    try {
      const args = [new URL("./worker.mjs", import.meta.url).pathname, engine, directory];
      const crashed = spawnSync(process.execPath, [...args, "crash"], { encoding: "utf8", timeout: 6000 });
      assert.equal(crashed.status, 73, crashed.stderr);
      const recovered = spawnSync(process.execPath, [...args, "recover"], { encoding: "utf8", timeout: 6000 });
      assert.equal(recovered.status, 0, recovered.stderr);
      const evidence = JSON.parse(recovered.stdout);
      assert.equal(evidence.status, "completed");
      assert.equal(evidence.acceptance, "accepted");
      assert.equal(evidence.messageCount, 2);
      assert.equal(evidence.connectorCalls, 0);
      assert.equal(readFileSync(join(directory, "connector.txt"), "utf8"), "connector\n");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

/** 构造稳定、显式 operation 的请求，避免把意图分类质量混入引擎测试。 */
export function runInput(message = "今天深圳天气") {
  return { operation: "conversation.chat", requestId: "poc-request", clientMessageId: "poc-message",
    message, imageUrls: [], documentUrls: [], references: [] };
}
/** 判断有效文本增量。 */
function isTextDelta(event) { return event.type === "text.delta"; }

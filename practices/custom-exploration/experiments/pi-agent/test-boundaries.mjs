import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionPolicy } from "../../src/runtime/execution-policy.mjs";
import { createFixture, PNG } from "./fixture.mjs";

for (const engine of ["ai-sdk", "pi"]) {
  // 两个真实 SQLite Runtime owner 不得同时执行同一会话的不同 Run。
  test(`${engine}: second SQLite owner cannot start a competing run`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-owner-poc-"));
    const databasePath = join(directory, "platform.sqlite");
    const first = createFixture({ engine, databasePath, scenario: "cancel" });
    const second = createFixture({ engine, databasePath });
    const controller = new AbortController();
    let pending;
    try {
      const conversation = first.runtime.createConversation();
      const input = { requestId: "owner-1", clientMessageId: "owner-1", operation: "conversation.chat",
        message: "今天深圳天气", imageUrls: [], documentUrls: [] };
      pending = first.runtime.runConversation(conversation.id, input, { abortSignal: controller.signal });
      const deadline = Date.now() + 2000;
      while (first.requests.length === 0 && Date.now() < deadline) await new Promise(setImmediate);
      assert.equal(first.requests.length, 1);
      await assert.rejects(second.runtime.runConversation(conversation.id, { ...input, requestId: "owner-2", clientMessageId: "owner-2" }),
        /** 保持宿主的 409 冲突边界；不靠模型或 Agent 自行判断并发。 */
        (error) => error.status === 409);
      assert.equal(second.requests.length, 0);
      assert.equal(second.getConnectorCalls(), 0);
    } finally {
      controller.abort();
      if (pending) await pending;
      first.close(); second.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  // 混合 Pi Adapter 必须继续使用原 SDK/Responses 的单次图片副作用路径。
  test(`${engine}: delegated image generation and editing keep gateway contract`, async () => {
    const fixture = createFixture({ engine });
    try {
      const generated = await fixture.gatewayClient.generateImages({ prompt: "红色印章", size: "1024x1024" });
      const edited = await fixture.gatewayClient.editImages({ prompt: "改成蓝色", size: "1024x1024",
        sourceImages: [{ bytes: Buffer.from(PNG, "base64"), mediaType: "image/png" }] });
      assert.equal(generated.images.length, 1);
      assert.equal(edited.images.length, 1);
      assert.equal(generated.resilience.attemptCount, 1);
      assert.equal(edited.resilience.attemptCount, 1);
      assert.equal(fixture.requests[0].url, "http://gateway.poc.invalid/v1/images/generations");
      assert.equal(fixture.requests[1].url, "http://gateway.poc.invalid/v1/responses");
      assert.equal(fixture.requests[1].body.tool_choice.type, "image_generation");
      assert.equal(fixture.requests[1].authorization, "Bearer poc-fake-key");
    } finally { fixture.close(); }
  });

  // 图片请求可能已发生副作用，503 也不得自动重复生成或编辑。
  test(`${engine}: delegated image failure never repeats side effect`, async () => {
    const fixture = createFixture({ engine, scenario: "image-failure" });
    try {
      await assert.rejects(fixture.gatewayClient.generateImages({ prompt: "红色印章" }));
      await assert.rejects(fixture.gatewayClient.editImages({ prompt: "改成蓝色",
        sourceImages: [{ bytes: Buffer.from(PNG, "base64"), mediaType: "image/png" }] }));
      assert.equal(fixture.requests.length, 2);
    } finally { fixture.close(); }
  });

  // 显式模型选择必须在网络请求里保持，不能只校验别名而使用默认模型。
  test(`${engine}: explicit alternate alias reaches provider`, async () => {
    const fixture = createFixture({ engine, scenario: "plain" });
    try {
      await fixture.gatewayClient.chatCompletions({ model: "poc-alt", messages: [{ role: "user", content: "你好" }] });
      assert.equal(fixture.requests[0].body.model, "poc-alt");
    } finally { fixture.close(); }
  });

  // 认证失败不得被误判为可重试瞬时错误；证据保留真实 HTTP 状态而不保存正文。
  test(`${engine}: HTTP 401 is permanent and redacted`, async () => {
    const fixture = createFixture({ engine, scenario: "unauthorized" });
    try {
      await assert.rejects(fixture.gatewayClient.chatCompletions({ messages: [{ role: "user", content: "你好" }] }),
        /** 检查 Adapter 的状态分类及单次尝试，不匹配 provider 敏感正文。 */
        (error) => {
          assert.equal(error.resilience.attemptCount, 1);
          assert.equal(error.resilience.attempts[0].statusCode, 401);
          assert.equal(error.resilience.attempts[0].retryable, false);
          assert.equal(JSON.stringify(error.resilience).includes("poc-sensitive-provider-text"), false);
          return true;
        });
      assert.equal(fixture.requests.length, 1);
    } finally { fixture.close(); }
  });

  // 并发相同幂等请求应交付同一已提交结果，只执行一次 Connector。
  test(`${engine}: concurrent duplicate request executes one connector`, async () => {
    const fixture = createFixture({ engine });
    try {
      const conversation = fixture.runtime.createConversation();
      const input = { requestId: "duplicate", clientMessageId: "duplicate", operation: "conversation.chat",
        message: "今天深圳天气", imageUrls: [], documentUrls: [] };
      const results = await Promise.all([fixture.runtime.runConversation(conversation.id, input),
        fixture.runtime.runConversation(conversation.id, input)]);
      assert.equal(fixture.getConnectorCalls(), 1);
      assert.equal(fixture.requests.length, 2);
      assert.equal(results[0].content, results[1].content);
      assert.equal(results[1].replayed, true);
    } finally { fixture.close(); }
  });

  // 工具开放后仍需执行宿主 Policy，不得通过 Pi 执行器绕过前置拒绝。
  test(`${engine}: restrictive policy prevents connector execution`, async () => {
    const executionPolicy = createExecutionPolicy({ allowedRunOperations: ["conversation.chat"], allowedReadTools: ["get_weather"],
      beforeHooks: [denyTool] });
    const fixture = createFixture({ engine, executionPolicy });
    try {
      const conversation = fixture.runtime.createConversation();
      await assert.rejects(fixture.runtime.runConversation(conversation.id, { requestId: "deny", clientMessageId: "deny",
        operation: "conversation.chat", message: "今天深圳天气", imageUrls: [], documentUrls: [] }));
      assert.equal(fixture.getConnectorCalls(), 0);
      assert.notEqual(fixture.runtime.getConversation(conversation.id).latestRun.status, "completed");
    } finally { fixture.close(); }
  });

  // 双轮同一会话共享平台历史，SDK 必须保持新旧消息顺序而不是从空上下文重开。
  test(`${engine}: second turn preserves canonical history`, async () => {
    const fixture = createFixture({ engine, scenario: "plain" });
    try {
      const conversation = fixture.runtime.createConversation();
      for (const index of [1, 2]) await fixture.runtime.runConversation(conversation.id,
        { requestId: `turn-${index}`, clientMessageId: `turn-${index}`, operation: "conversation.chat",
          message: `你好${index}`, imageUrls: [], documentUrls: [] });
      assert.deepEqual(fixture.requests[1].body.messages.filter(isNonSystem).map(readRole), ["user", "assistant", "user"]);
      assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 4);
    } finally { fixture.close(); }
  });

  // 多模态输入是 Pi PoC 尚未实现的边界，显式检验并登记，不能静默丢图。
  test(`${engine}: vision compatibility boundary is explicit`, async () => {
    const fixture = createFixture({ engine, scenario: "plain" });
    try {
      const pending = fixture.gatewayClient.chatCompletions({ messages: [{ role: "user", content: [
        { type: "text", text: "描述图片" }, { type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] });
      if (engine === "pi") {
        await assert.rejects(pending,
          /** 当前 Pi Adapter 必须明确拒绝，不能报告视觉能力通过。 */
          (error) => error.data.code === "pi_poc_unsupported_message");
        assert.equal(fixture.requests.length, 0);
      } else {
        await pending;
        assert.equal(fixture.requests[0].body.messages.at(-1).content[1].type, "image_url");
      }
    } finally { fixture.close(); }
  });
}
/** 只收紧工具阶段，保持 Run 本身允许执行。 */
function denyTool({ context }) {
  return context.kind === "tool" ? { decision: "deny", reasonCodes: ["poc_tool_denied"] } : null;
}
/** 排除 system/developer 消息，比较对话事实顺序。 */
function isNonSystem(message) { return message.role !== "system" && message.role !== "developer"; }
/** 提取协议角色。 */
function readRole(message) { return message.role; }

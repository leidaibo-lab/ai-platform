#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeAdapterError,
  createRuntimeAdapter,
} from "../demo/src/runtime-adapter.js";
import {
  canSubmitRun,
  conversationStatusLabel,
  insertLatestRunFailure,
  recoverRunInput,
} from "../demo/src/conversation-view-model.js";

/** 验证 Adapter 能跨任意网络分块恢复 run-started、文本增量和完成事实。 */
async function testCompletedRunStream() {
  const requests = [];
  /** 返回被刻意拆分的 completed SSE，并记录渠道请求。 */
  async function fakeFetch(path, options) {
    requests.push({ path, options });
    return sseResponse([
      ": connected\n\n",
      "event: run-started\ndata: {\"runId\":\"run-1\",\"status\":\"running\"}\n",
      "\nevent: text-delta\ndata: {\"delta\":\"流式\"}\n\n",
      "event: text-delta\ndata: {\"delta\":\"回复\"}\n\n",
      "event: completed\ndata: {\"content\":\"流式回复\",\"conversation\":{\"id\":\"conversation-1\"}}\n\n",
    ]);
  }
  const adapter = createRuntimeAdapter({ fetchImpl: fakeFetch });
  const stages = [];
  /** 记录稳定 Run ID。 */
  function recordRunStarted(event) {
    stages.push(`run:${event.runId}`);
  }
  /** 记录每个文本增量。 */
  function recordTextDelta(delta) {
    stages.push(`delta:${delta}`);
  }
  /** 记录完成载荷。 */
  function recordCompleted(result) {
    stages.push(`completed:${result.content}`);
  }
  const terminal = await adapter.runConversationStream(
    "conversation/1",
    { requestId: "request-1", clientMessageId: "message-1", message: "验证" },
    { onRunStarted: recordRunStarted, onTextDelta: recordTextDelta, onCompleted: recordCompleted },
  );

  assert.equal(terminal.type, "completed");
  assert.equal(terminal.data.content, "流式回复");
  assert.deepEqual(stages, ["run:run-1", "delta:流式", "delta:回复", "completed:流式回复"]);
  assert.equal(requests[0].path, "/api/runtime/conversations/conversation%2F1/runs/stream");
  assert.equal(requests[0].options.method, "POST");
}

/** 验证 cancelled 是独立正常终止类型，不会被 Adapter 改写为异常。 */
async function testCancelledRunStream() {
  /** 返回包含中断助手消息的 cancelled SSE。 */
  async function fakeFetch() {
    return sseResponse([
      "event: run-started\ndata: {\"runId\":\"run-cancel\"}\n\n",
      "event: text-delta\ndata: {\"delta\":\"部分结果\"}\n\n",
      "event: cancelled\ndata: {\"cancelled\":true,\"assistantMessage\":{\"status\":\"interrupted\"}}\n\n",
    ]);
  }
  const adapter = createRuntimeAdapter({ fetchImpl: fakeFetch });
  let cancelledResult = null;
  /** 保存渠道收到的取消事实。 */
  function recordCancelled(result) {
    cancelledResult = result;
  }
  const terminal = await adapter.runConversationStream(
    "conversation-1",
    { requestId: "request-cancel", clientMessageId: "message-cancel", message: "停止" },
    { onCancelled: recordCancelled },
  );

  assert.equal(terminal.type, "cancelled");
  assert.equal(cancelledResult.cancelled, true);
  assert.equal(cancelledResult.assistantMessage.status, "interrupted");
}

/** 验证 error SSE 保留公开消息和状态，并阻止缺少终止事实的流静默成功。 */
async function testErrorRunStream() {
  /** 返回 Runtime 已脱敏的 error SSE。 */
  async function fakeFetch() {
    return sseResponse([
      "event: run-started\ndata: {\"runId\":\"run-error\"}\n\n",
      "event: error\ndata: {\"error\":\"模型网关超时\",\"status\":504}\n\n",
    ]);
  }
  const adapter = createRuntimeAdapter({ fetchImpl: fakeFetch });
  await assert.rejects(
    adapter.runConversationStream(
      "conversation-1",
      { requestId: "request-error", clientMessageId: "message-error", message: "失败" },
    ),
    /** 只接受公开 Adapter 错误，不暴露底层响应对象。 */
    function matchesAdapterError(error) {
      return error instanceof RuntimeAdapterError && error.message === "模型网关超时" && error.status === 504;
    },
  );
}

/** 验证 JSON 资源与取消端点的路径、方法和请求体保持现有 Runtime 契约。 */
async function testJsonResourceMapping() {
  const requests = [];
  /** 为 JSON 方法返回最小成功载荷并记录请求。 */
  async function fakeFetch(path, options = {}) {
    requests.push({ path, options });
    if (path === "/api/runtime/conversations") {
      if (options.method === "POST") return jsonResponse({ id: "conversation-1", status: "active" }, 201);
      return jsonResponse({ conversations: [{ id: "conversation-1" }] });
    }
    if (path.endsWith("/cancel")) return jsonResponse({ run: { id: "run-1", status: "cancelled" } });
    if (path.endsWith("/close")) return jsonResponse({ conversation: { id: "conversation-1", status: "closed" } });
    return jsonResponse({ id: "conversation-1", messages: [] });
  }
  const adapter = createRuntimeAdapter({ fetchImpl: fakeFetch });
  assert.equal((await adapter.listConversations()).length, 1);
  assert.equal((await adapter.createConversation()).status, "active");
  assert.equal((await adapter.getConversation("conversation-1")).messages.length, 0);
  assert.equal((await adapter.cancelRun("conversation-1", "run/1")).run.status, "cancelled");
  assert.equal((await adapter.closeConversation("conversation-1")).conversation.status, "closed");
  assert.equal(requests[3].path, "/api/runtime/conversations/conversation-1/runs/run%2F1/cancel");
  assert.equal(requests[3].options.method, "POST");
  assert.equal(requests[4].path, "/api/runtime/conversations/conversation-1/close");
}

/** 验证失败提示只锚定同 Run 用户消息，且不会把原始错误带入渠道消息。 */
function testLatestRunFailureMarker() {
  const messages = [
    { id: "message-1", runId: "run-1", role: "user", displayContent: "失败输入" },
    { id: "message-older", runId: "run-older", role: "user", displayContent: "更早输入" },
  ];
  const result = insertLatestRunFailure(messages, {
    id: "run-1",
    conversationId: "conversation-1",
    status: "failed",
    error: "provider secret body",
  });
  assert.equal(result[1].kind, "run-failure");
  assert.equal(result[1].sourceMessageId, "message-1");
  assert.equal("error" in result[1], false);
  assert.deepEqual(insertLatestRunFailure(messages, { id: "run-1", status: "completed" }), messages);
}

/** 验证失败输入可从持久化展示和多模态事实恢复，不复用旧 requestId。 */
function testRecoverRunInput() {
  const recovered = recoverRunInput({
    displayContent: "分析架构\n\n图片：1 个\n\n参考文档链接：\n- https://example.com/spec.pdf",
    content: [
      { type: "text", text: "分析架构" },
      { type: "text", text: "参考文档链接：\n- https://example.com/spec.pdf" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ],
    references: [{ type: "conversation_message", messageId: "message-source" }],
  });
  assert.deepEqual(recovered, {
    message: "分析架构",
    imageUrls: ["data:image/png;base64,AAAA"],
    documentUrls: ["https://example.com/spec.pdf"],
    references: [{ type: "conversation_message", messageId: "message-source" }],
  });
}

/** 验证网关和会话生命周期共同约束发送，状态文案不与模型生成混淆。 */
function testChannelStatusModel() {
  assert.equal(canSubmitRun({ conversationStatus: "active", gatewayOk: true, activeRun: null, hasInput: true }), true);
  assert.equal(canSubmitRun({ conversationStatus: "active", gatewayOk: false, activeRun: null, hasInput: true }), false);
  assert.equal(canSubmitRun({ conversationStatus: "closed", gatewayOk: true, activeRun: null, hasInput: true }), false);
  assert.equal(conversationStatusLabel("active"), "可继续");
  assert.equal(conversationStatusLabel("closed"), "已结束");
}

test("Demo Adapter maps completed POST SSE", testCompletedRunStream);
test("Demo Adapter maps cancelled POST SSE", testCancelledRunStream);
test("Demo Adapter maps error POST SSE", testErrorRunStream);
test("Demo Adapter preserves JSON resource paths", testJsonResourceMapping);
test("Demo view model persists the latest failed Run marker", testLatestRunFailureMarker);
test("Demo view model recovers failed Run input", testRecoverRunInput);
test("Demo view model guards submission and labels lifecycle", testChannelStatusModel);

/** 创建由指定 UTF-8 分块组成的 SSE Response。 */
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    /** 按测试定义的网络边界依次写入并结束响应。 */
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

/** 创建 JSON Response 供 Adapter 资源方法测试。 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

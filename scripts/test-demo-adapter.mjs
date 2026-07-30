#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeAdapterError,
  createRuntimeAdapter,
} from "../demo/src/runtime-adapter.js";
import {
  activeRunStageLabel,
  buildConversationAnchors,
  buildGatewayReachabilityCopy,
  buildRunFailureCopy,
  canSubmitRun,
  conversationStatusLabel,
  insertLatestRunFailure,
  isMessageListAtLatest,
  readConversationDraft,
  readGatewayModels,
  recoverRunInput,
  scrollMessageListToLatest,
  storeConversationDraft,
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
    { requestId: "request-1", clientMessageId: "message-1", model: "chat-quality", message: "验证" },
    { onRunStarted: recordRunStarted, onTextDelta: recordTextDelta, onCompleted: recordCompleted },
  );

  assert.equal(terminal.type, "completed");
  assert.equal(terminal.data.content, "流式回复");
  assert.deepEqual(stages, ["run:run-1", "delta:流式", "delta:回复", "completed:流式回复"]);
  assert.equal(requests[0].path, "/api/runtime/conversations/conversation%2F1/runs/stream");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(JSON.parse(requests[0].options.body).model, "chat-quality");
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
    model: "chat-default",
    resilience: {
      attempts: [{ status: "failed", errorType: "authorization", statusCode: 401 }],
    },
  });
  assert.equal(result[1].kind, "run-failure");
  assert.equal(result[1].sourceMessageId, "message-1");
  assert.equal("error" in result[1], false);
  assert.deepEqual(result[1].failure, {
    title: "模型鉴权失败",
    detail: "chat-default 的上游访问凭据无效或没有权限。",
    action: "请检查模型服务凭据与模型访问权限后重试。",
    code: "model_authorization_failed",
  });
  assert.deepEqual(insertLatestRunFailure(messages, { id: "run-1", status: "completed" }), messages);
}

/** 验证失败反馈按安全分类给出原因和处理建议，不回显 provider 原始正文。 */
function testRunFailureCopy() {
  assert.deepEqual(buildRunFailureCopy({
    model: "chat-default",
    error: "provider secret body",
    resilience: { attempts: [{ status: "failed", errorType: "rate_limit", statusCode: 429 }] },
  }), {
    title: "模型服务限流",
    detail: "chat-default 当前请求过于频繁或额度暂时受限。",
    action: "请稍后重试，或切换到其他可用模型。",
    code: "model_rate_limited",
  });
  assert.equal(buildRunFailureCopy({
    model: "chat-default",
    resilience: { attempts: [{ status: "failed", errorType: "timeout", statusCode: 504 }] },
  }).title, "模型响应超时");
  assert.equal(buildRunFailureCopy({
    model: "chat-default",
    resilience: { attempts: [{ status: "failed", errorType: "provider_unavailable", statusCode: 503 }] },
  }).title, "模型服务暂时不可用");
  assert.equal(buildRunFailureCopy({
    model: "chat-default",
    publicError: { code: "unsupported_model" },
  }).title, "所选模型不可用");
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
  assert.deepEqual(buildGatewayReachabilityCopy(null), {
    state: "checking",
    label: "正在检查",
    announcement: "正在检查模型网关",
    detail: "正在检查 LiteLLM /v1/models",
  });
  assert.deepEqual(buildGatewayReachabilityCopy({
    ok: true,
    model: "chat-default",
    gatewayBaseUrl: "http://localhost:4000/v1",
  }), {
    state: "reachable",
    label: "网关可达 · chat-default",
    announcement: "模型网关可达：chat-default；上游生成能力未验证",
    detail: "http://localhost:4000/v1；仅验证 LiteLLM /v1/models，上游生成能力需以实际请求为准",
  });
  assert.deepEqual(buildGatewayReachabilityCopy({ ok: false, error: "ECONNREFUSED" }), {
    state: "unreachable",
    label: "模型网关不可达",
    announcement: "模型网关仍不可达",
    detail: "ECONNREFUSED",
  });
  assert.deepEqual(
    readGatewayModels({ model: "chat-default", models: ["chat-default", "chat-quality", "chat-default"] }),
    ["chat-default", "chat-quality"],
  );
  assert.deepEqual(readGatewayModels({ model: "chat-default" }), ["chat-default"]);
}

/** 验证会话锚点只保留用户消息，并排除助手回复和失败提示等派生展示项。 */
function testConversationAnchors() {
  const anchors = buildConversationAnchors([
    { id: "message-1", role: "user", displayContent: "检查当前方案\n的边界" },
    { id: "message-2", role: "assistant", displayContent: "边界已确认" },
    { id: "run-failure:run-1", kind: "run-failure", role: "assistant", displayContent: "本次生成失败" },
    { id: "message-3", role: "assistant", displayContent: "", streaming: true },
  ]);
  assert.deepEqual(anchors, [
    { id: "message-1", preview: "检查当前方案 的边界" },
  ]);
}

/** 验证草稿按 conversationId 隔离、读取返回副本且空草稿会清理旧值。 */
function testConversationDraftIsolation() {
  const initial = new Map();
  const first = storeConversationDraft(initial, "conversation-1", {
    value: "会话一草稿",
    attachments: [{ uid: "attachment-1" }],
    references: [{ messageId: "message-1" }],
    model: "chat-quality",
  });
  const second = storeConversationDraft(first, "conversation-2", {
    value: "会话二草稿",
    attachments: [],
    references: [],
    model: "chat-default",
  });
  assert.equal(initial.size, 0);
  assert.equal(readConversationDraft(second, "conversation-1").value, "会话一草稿");
  assert.equal(readConversationDraft(second, "conversation-1").model, "chat-quality");
  assert.equal(readConversationDraft(second, "conversation-2").value, "会话二草稿");

  const restored = readConversationDraft(second, "conversation-1");
  restored.attachments.push({ uid: "attachment-local" });
  assert.equal(readConversationDraft(second, "conversation-1").attachments.length, 1);

  const cleared = storeConversationDraft(second, "conversation-1", {
    value: "",
    attachments: [],
    references: [],
    model: "chat-quality",
  });
  assert.equal(cleared.has("conversation-1"), true);
  assert.equal(readConversationDraft(cleared, "conversation-1").value, "");
  assert.equal(readConversationDraft(cleared, "conversation-1").model, "chat-quality");
  assert.equal(cleared.get("conversation-2").value, "会话二草稿");
}

/** 验证长会话跟随阈值和活动 Run 状态只映射已有渠道事实。 */
function testConversationProgressModel() {
  assert.equal(isMessageListAtLatest(0), true);
  assert.equal(isMessageListAtLatest(-20), true);
  assert.equal(isMessageListAtLatest(-25), false);
  assert.equal(activeRunStageLabel("starting", false), "正在连接模型");
  assert.equal(activeRunStageLabel("running", false), "正在等待模型响应");
  assert.equal(activeRunStageLabel("running", true), "正在生成回答");
  assert.equal(activeRunStageLabel("stopping", true), "正在停止生成");
}

/** 验证空会话首次挂载时不会提前调用 Bubble.List 的内部滚动命令。 */
function testMessageListReadyGuard() {
  let scrollOptions = null;
  const mountingList = {
    /** 未就绪时一旦被调用就立即暴露回归。 */
    scrollTo() {
      throw new Error("未就绪的 Bubble.List 不应执行 scrollTo");
    },
  };
  assert.equal(scrollMessageListToLatest(null), false);
  assert.equal(scrollMessageListToLatest(mountingList), false);

  const readyList = {
    scrollBoxNativeElement: {},
    /** 记录发给第三方组件的稳定滚动命令。 */
    scrollTo(options) {
      scrollOptions = options;
    },
  };
  assert.equal(scrollMessageListToLatest(readyList, "instant"), true);
  assert.deepEqual(scrollOptions, { top: "bottom", behavior: "instant" });
}

test("Demo Adapter maps completed POST SSE", testCompletedRunStream);
test("Demo Adapter maps cancelled POST SSE", testCancelledRunStream);
test("Demo Adapter maps error POST SSE", testErrorRunStream);
test("Demo Adapter preserves JSON resource paths", testJsonResourceMapping);
test("Demo view model persists the latest failed Run marker", testLatestRunFailureMarker);
test("Demo view model maps safe run failure feedback", testRunFailureCopy);
test("Demo view model recovers failed Run input", testRecoverRunInput);
test("Demo view model guards submission and labels lifecycle", testChannelStatusModel);
test("Demo view model builds conversation anchors", testConversationAnchors);
test("Demo view model isolates conversation drafts", testConversationDraftIsolation);
test("Demo view model maps message progress", testConversationProgressModel);
test("Demo view model guards message list mount scrolling", testMessageListReadyGuard);

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

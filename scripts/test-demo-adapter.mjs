#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeAdapterError,
  createRuntimeAdapter,
} from "../demo/src/runtime-adapter.js";
import {
  activeRunStatusForOperation,
  activeRunStageLabel,
  buildConversationAnchors,
  buildConversationWorkspace,
  buildGatewayReachabilityCopy,
  buildMessageWindow,
  buildRunFailureCopy,
  canSubmitRun,
  conversationStatusLabel,
  deserializeConversationDrafts,
  extractMarkdownHeadings,
  imageAttachmentReservationError,
  insertLatestRunFailure,
  isAttachmentPreparationCurrent,
  isMessageListAtLatest,
  isSafeMarkdownHref,
  readConversationDraft,
  readGatewayDefaultModel,
  readGatewayModels,
  readGatewayModelsForOperation,
  recoverRunInput,
  scrollMessageListToLatest,
  selectAutoImageAssetSource,
  selectEditableImageArtifact,
  serializeConversationDrafts,
  storeConversationDraft,
} from "../demo/src/conversation-view-model.js";
import {
  findRunByRequestId,
  waitForRunTerminalFact,
} from "../demo/src/run-reconciliation.js";

/** 验证 Adapter 能跨任意网络分块恢复 run-started、文本增量和完成事实。 */
async function testCompletedRunStream() {
  const requests = [];
  /** 返回被刻意拆分的 completed SSE，并记录渠道请求。 */
  async function fakeFetch(path, options) {
    requests.push({ path, options });
    return sseResponse([
      ": connected\n\n",
      "event: run-started\ndata: {\"runId\":\"run-1\",\"status\":\"running\",\"operation\":\"image.edit\"}\n",
      "\nevent: tool-started\ndata: {\"toolCallId\":\"call-1\",\"toolName\":\"get_weather\",\"title\":\"实时天气\"}\n\n",
      "event: tool-completed\ndata: {\"toolCallId\":\"call-1\",\"toolName\":\"get_weather\",\"source\":\"Open-Meteo\"}\n\n",
      "event: artifact-created\ndata: {\"assetId\":\"asset-1\",\"type\":\"image_asset\"}\n\n",
      "\nevent: text-delta\ndata: {\"delta\":\"流式\"}\n\n",
      "event: text-delta\ndata: {\"delta\":\"回复\"}\n\n",
      "event: completed\ndata: {\"content\":\"流式回复\",\"conversation\":{\"id\":\"conversation-1\"}}\n\n",
    ]);
  }
  const adapter = createRuntimeAdapter({ fetchImpl: fakeFetch });
  const stages = [];
  /** 记录稳定 Run ID。 */
  function recordRunStarted(event) {
    stages.push(`run:${event.runId}:${event.operation}`);
  }
  /** 记录每个文本增量。 */
  function recordTextDelta(delta) {
    stages.push(`delta:${delta}`);
  }
  /** 记录服务端产生的工具阶段。 */
  function recordToolEvent(event) {
    stages.push(`${event.event}:${event.toolName}`);
  }
  /** 记录已经完成持久化的图片资产。 */
  function recordArtifact(artifact) {
    stages.push(`artifact:${artifact.assetId}`);
  }
  /** 记录完成载荷。 */
  function recordCompleted(result) {
    stages.push(`completed:${result.content}`);
  }
  const terminal = await adapter.runConversationStream(
    "conversation/1",
    { requestId: "request-1", clientMessageId: "message-1", model: "chat-quality", message: "验证" },
    {
      onRunStarted: recordRunStarted,
      onToolEvent: recordToolEvent,
      onArtifactCreated: recordArtifact,
      onTextDelta: recordTextDelta,
      onCompleted: recordCompleted,
    },
  );

  assert.equal(terminal.type, "completed");
  assert.equal(terminal.data.content, "流式回复");
  assert.deepEqual(stages, [
    "run:run-1:image.edit",
    "tool-started:get_weather",
    "tool-completed:get_weather",
    "artifact:asset-1",
    "delta:流式",
    "delta:回复",
    "completed:流式回复",
  ]);
  assert.equal(requests[0].path, "/api/runtime/conversations/conversation%2F1/runs/stream");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(JSON.parse(requests[0].options.body).model, "chat-quality");
}

/** 验证页面断线协调超过提示阈值后仍持有发送门禁，并在迟到终态出现时正常释放。 */
async function testRunReconciliationAfterStalledThreshold() {
  let clock = 0;
  let reads = 0;
  let stalledNotifications = 0;
  let sendLocked = true;

  /** 前三次返回运行中事实，第四次模拟后台迟到的完成 checkpoint。 */
  async function readConversation() {
    reads += 1;
    return {
      latestRun: {
        id: "run-reconcile",
        requestId: "request-reconcile",
        operation: "image.edit",
        status: reads >= 4 ? "completed" : "running",
      },
    };
  }

  /** 页面持有同一活动 requestId 时允许协调器继续查询。 */
  function shouldContinue() {
    return sendLocked;
  }

  /** 推进确定性测试时钟，不执行真实定时等待。 */
  async function advanceClock(delayMs) {
    clock += Math.max(1, delayMs);
  }

  /** 返回确定性测试时钟。 */
  function readClock() {
    return clock;
  }

  /** 记录长时间运行提示，并确认提示本身没有解除发送门禁。 */
  function recordStalledRun() {
    stalledNotifications += 1;
    assert.equal(sendLocked, true);
  }

  const outcome = await waitForRunTerminalFact("conversation-1", "request-reconcile", {
    readConversation,
    shouldContinue,
    onStalled: recordStalledRun,
    now: readClock,
    wait: advanceClock,
    pollMs: 1,
    notFoundMs: 2,
    stalledMs: 1,
  });
  assert.equal(outcome.state, "completed");
  assert.equal(outcome.run.id, "run-reconcile");
  assert.equal(stalledNotifications, 1);
  assert.equal(reads, 4);
  assert.equal(sendLocked, true);
  sendLocked = false;
  assert.equal(sendLocked, false);
  assert.equal(findRunByRequestId(outcome.detail, "request-reconcile")?.status, "completed");
}

/** 验证连续读取失败不能被误判为 Run 未创建，恢复读取后仍按原 requestId 接收终态。 */
async function testRunReconciliationIgnoresReadFailures() {
  let clock = 0;
  let reads = 0;

  /** 前三次模拟详情接口抖动，随后返回已完成的同一 Run。 */
  async function readConversation() {
    reads += 1;
    if (reads <= 3) throw new Error("temporary read failure");
    return {
      latestRun: {
        id: "run-after-read-errors",
        requestId: "request-after-read-errors",
        status: "completed",
      },
    };
  }

  /** 测试期间始终保留组件所有权。 */
  function shouldContinue() {
    return true;
  }

  /** 推进确定性测试时钟。 */
  async function advanceClock(delayMs) {
    clock += Math.max(1, delayMs);
  }

  /** 返回确定性测试时钟。 */
  function readClock() {
    return clock;
  }

  const outcome = await waitForRunTerminalFact("conversation-1", "request-after-read-errors", {
    readConversation,
    shouldContinue,
    now: readClock,
    wait: advanceClock,
    pollMs: 1,
    notFoundMs: 1,
    stalledMs: 100,
  });
  assert.equal(outcome.state, "completed");
  assert.equal(reads, 4);
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

/** 验证 JSON 资源与 Run/requestId 两级取消端点的路径、方法和请求体。 */
async function testJsonResourceMapping() {
  const requests = [];
  /** 为 JSON 方法返回最小成功载荷并记录请求。 */
  async function fakeFetch(path, options = {}) {
    requests.push({ path, options });
    if (path === "/api/runtime/conversations") {
      if (options.method === "POST") return jsonResponse({ id: "conversation-1", status: "active" }, 201);
      return jsonResponse({ conversations: [{ id: "conversation-1" }] });
    }
    if (path.includes("/run-requests/")) {
      return jsonResponse({ cancellationRequested: true, requestId: "request/1", runId: null }, 202);
    }
    if (path.endsWith("/cancel")) return jsonResponse({ run: { id: "run-1", status: "cancelled" } });
    if (path.endsWith("/close")) return jsonResponse({ conversation: { id: "conversation-1", status: "closed" } });
    return jsonResponse({ id: "conversation-1", messages: [] });
  }
  const adapter = createRuntimeAdapter({ fetchImpl: fakeFetch });
  assert.equal((await adapter.listConversations()).length, 1);
  assert.equal((await adapter.createConversation()).status, "active");
  assert.equal((await adapter.getConversation("conversation-1")).messages.length, 0);
  assert.equal((await adapter.updateConversation("conversation-1", { archived: true })).id, "conversation-1");
  assert.equal((await adapter.cancelRun("conversation-1", "run/1")).run.status, "cancelled");
  assert.equal(
    (await adapter.cancelRunRequest("conversation-1", "request/1")).cancellationRequested,
    true,
  );
  assert.equal((await adapter.closeConversation("conversation-1")).conversation.status, "closed");
  assert.equal(requests[3].path, "/api/runtime/conversations/conversation-1");
  assert.equal(requests[3].options.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[3].options.body), { archived: true });
  assert.equal(requests[4].path, "/api/runtime/conversations/conversation-1/runs/run%2F1/cancel");
  assert.equal(requests[4].options.method, "POST");
  assert.equal(requests[5].path, "/api/runtime/conversations/conversation-1/run-requests/request%2F1/cancel");
  assert.equal(requests[5].options.method, "POST");
  assert.equal(requests[6].path, "/api/runtime/conversations/conversation-1/close");
}

/** 验证渠道 Adapter 以原始图片二进制调用会话资产上传入口。 */
async function testImageAssetUploadMapping() {
  const requests = [];
  /** 记录上传请求并返回稳定图片资产。 */
  async function fakeFetch(path, options = {}) {
    requests.push({ path, options });
    return jsonResponse({
      type: "image_asset",
      assetId: "asset-upload-1",
      mediaType: "image/png",
      source: "uploaded",
    }, 201);
  }
  const adapter = createRuntimeAdapter({ fetchImpl: fakeFetch });
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const image = new Blob([bytes], { type: "image/png" });

  const asset = await adapter.uploadImageAsset("conversation/1", image);

  assert.equal(asset.assetId, "asset-upload-1");
  assert.equal(requests[0].path, "/api/runtime/conversations/conversation%2F1/image-assets");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["Content-Type"], "image/png");
  assert.ok(requests[0].options.body instanceof Blob);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.deepEqual(new Uint8Array(await requests[0].options.body.arrayBuffer()), bytes);
}

/** 验证页面取消信号会终止图片上传，并映射为不依赖浏览器原始文案的稳定错误。 */
async function testImageAssetUploadCancellation() {
  /** 等待 Adapter 组合后的信号终止当前 fake Fetch。 */
  async function fakeFetch(path, options) {
    return new Promise(
      // Promise executor 只模拟一个等待 AbortSignal 的上传请求。
      (resolve, reject) => {
        /** 使用组合信号的标准取消原因拒绝 fake Fetch。 */
        function rejectOnAbort() {
          reject(options.signal.reason);
        }
        if (options.signal.aborted) rejectOnAbort();
        else options.signal.addEventListener("abort", rejectOnAbort, { once: true });
      },
    );
  }
  const controller = new AbortController();
  const adapter = createRuntimeAdapter({ fetchImpl: fakeFetch });
  const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const upload = adapter.uploadImageAsset("conversation-1", image, { abortSignal: controller.signal });
  controller.abort(new DOMException("用户取消", "AbortError"));

  await assert.rejects(
    upload,
    /** 取消必须使用稳定公开分类，不能把 DOMException 直接交给页面。 */
    function matchesImageUploadCancellation(error) {
      return error instanceof RuntimeAdapterError &&
        error.status === 499 &&
        error.payload?.code === "image_upload_cancelled";
    },
  );
}

/** 验证图片上传超过渠道时限后会主动终止 Fetch，并返回稳定超时分类。 */
async function testImageAssetUploadTimeout() {
  /** 等待 Adapter 的本地超时信号终止当前 fake Fetch。 */
  async function fakeFetch(path, options) {
    return new Promise(
      // Promise executor 只模拟一个永不自行完成的上传请求。
      (resolve, reject) => {
        /** 使用超时信号原因拒绝 fake Fetch。 */
        function rejectOnAbort() {
          reject(options.signal.reason);
        }
        if (options.signal.aborted) rejectOnAbort();
        else options.signal.addEventListener("abort", rejectOnAbort, { once: true });
      },
    );
  }
  const adapter = createRuntimeAdapter({ fetchImpl: fakeFetch, imageUploadTimeoutMs: 5 });
  const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

  await assert.rejects(
    adapter.uploadImageAsset("conversation-1", image),
    /** 超时必须与用户取消分开，供 UI 决定是否展示错误。 */
    function matchesImageUploadTimeout(error) {
      return error instanceof RuntimeAdapterError &&
        error.status === 408 &&
        error.payload?.code === "image_upload_timeout";
    },
  );
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
  assert.deepEqual(buildRunFailureCopy({
    model: "gpt-5.6",
    operation: "image.edit",
    statusCode: 502,
    publicError: { code: "image_edit_provider_unavailable" },
  }), {
    title: "图片编辑上游不可用",
    detail: "gpt-5.6 的上游未接受 Responses 图片编辑工具请求。",
    action: "请使用支持该协议且已开通 GPT Image 工具权限的中转站凭据。",
    code: "image_edit_provider_unavailable",
  });
  assert.equal(buildRunFailureCopy({
    model: "chat-default",
    publicError: { code: "unsupported_model" },
  }).title, "所选模型不可用");
  assert.deepEqual(buildRunFailureCopy({
    model: "image-default",
    operation: "conversation.chat",
    publicError: { code: "model_capability_mismatch" },
  }), {
    title: "模型能力不匹配",
    detail: "image-default 不能用于当前对话或图片理解。",
    action: "请使用支持当前输入类型的对话模型后重试。",
    code: "model_capability_mismatch",
  });
  assert.deepEqual(buildRunFailureCopy({
    model: "chat-default",
    operation: "image.generate",
    publicError: { code: "model_capability_mismatch" },
  }), {
    title: "模型能力不匹配",
    detail: "chat-default 不能用于当前图片操作。",
    action: "请使用当前操作对应的图片模型后重试。",
    code: "model_capability_mismatch",
  });
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
    imageAssets: [],
    operation: "conversation.chat",
  });

  const recoveredImageEdit = recoverRunInput({
    displayContent: "保留构图并改成水彩\n\n源图片：1 张",
    content: "保留构图并改成水彩",
    references: [{ type: "image_asset", assetId: "asset-source" }],
    referenceAssets: [{
      type: "image_asset",
      assetId: "asset-source",
      mediaType: "image/png",
      url: "/api/runtime/conversations/conversation-1/image-assets/asset-source/content",
    }],
  }, "image.edit");
  assert.equal(recoveredImageEdit.operation, "image.edit");
  assert.equal(recoveredImageEdit.message, "保留构图并改成水彩");
  assert.deepEqual(recoveredImageEdit.references, []);
  assert.equal(recoveredImageEdit.imageAssets[0].assetId, "asset-source");
  assert.match(recoveredImageEdit.imageAssets[0].url, /asset-source\/content$/);

  const inferredLegacyImageEdit = recoverRunInput({
    displayContent: "改成线稿\n\n源图片：1 张",
    references: [{ type: "image_asset", assetId: "asset-legacy" }],
  });
  assert.equal(inferredLegacyImageEdit.operation, "image.edit");
  assert.deepEqual(inferredLegacyImageEdit.imageAssets, [{ type: "image_asset", assetId: "asset-legacy" }]);
}

/** 验证 FileReader 预留会计入单图限制，且异步结果只能提交到发起读取的原会话。 */
function testImageAttachmentPreparationGuards() {
  assert.equal(imageAttachmentReservationError({
    operation: "image.edit",
    attachmentCount: 0,
    imageCount: 0,
    pendingImageReads: 1,
    maxAttachments: 8,
    maxImages: 4,
  }), "image_edit_source_limit");
  assert.equal(imageAttachmentReservationError({
    operation: "auto",
    attachmentCount: 1,
    imageCount: 1,
    pendingImageReads: 1,
    maxAttachments: 8,
    maxImages: 4,
  }), null);
  assert.equal(imageAttachmentReservationError({
    operation: "conversation.chat",
    attachmentCount: 1,
    imageCount: 1,
    pendingImageReads: 1,
    maxAttachments: 8,
    maxImages: 4,
  }), null);
  assert.equal(isAttachmentPreparationCurrent("conversation-1", "conversation-1", false), true);
  assert.equal(isAttachmentPreparationCurrent("conversation-1", "conversation-2", false), false);
  assert.equal(isAttachmentPreparationCurrent("conversation-1", "conversation-1", true), false);
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
  const capabilityStatus = {
    model: "chat-default",
    imageModel: "image-default",
    imageEditModel: "edit-default",
    defaultModels: {
      "conversation.chat": "chat-default",
      "image.generate": "image-default",
      "image.edit": "edit-default",
    },
    models: ["chat-default", "chat-quality", "image-default", "edit-default", "vision-only"],
    modelCapabilities: {
      chat: ["chat-default", "chat-quality", "chat-default"],
      vision: ["chat-default", "vision-only"],
      imageGeneration: ["image-default"],
      imageEditing: ["edit-default"],
    },
  };
  assert.deepEqual(
    readGatewayModelsForOperation(capabilityStatus, "conversation.chat"),
    ["chat-default", "chat-quality"],
  );
  assert.deepEqual(
    readGatewayModelsForOperation(capabilityStatus, "conversation.chat", { requiresVision: true }),
    ["chat-default"],
  );
  assert.deepEqual(
    readGatewayModelsForOperation(capabilityStatus, "image.generate"),
    ["image-default"],
  );
  assert.deepEqual(
    readGatewayModelsForOperation(capabilityStatus, "image.edit"),
    ["edit-default"],
  );
  assert.equal(readGatewayDefaultModel(capabilityStatus, "conversation.chat"), "chat-default");
  assert.equal(readGatewayDefaultModel(capabilityStatus, "image.generate"), "image-default");
  assert.equal(readGatewayDefaultModel(capabilityStatus, "image.edit"), "edit-default");
  assert.equal(readGatewayDefaultModel(capabilityStatus, "auto"), "");
  assert.deepEqual(readGatewayModelsForOperation(capabilityStatus, "auto"), []);
  assert.deepEqual(
    readGatewayModelsForOperation({ ...capabilityStatus, modelCapabilities: { ...capabilityStatus.modelCapabilities, chat: [] } }, "conversation.chat"),
    [],
  );
  const legacyStatus = {
    model: "chat-default",
    imageModel: "image-default",
    models: ["chat-default", "chat-quality", "image-default"],
  };
  assert.deepEqual(
    readGatewayModelsForOperation(legacyStatus, "conversation.chat"),
    ["chat-default", "chat-quality"],
  );
  assert.deepEqual(
    readGatewayModelsForOperation(legacyStatus, "image.generate"),
    ["image-default"],
  );
  assert.deepEqual(
    readGatewayModelsForOperation({ model: "chat-default", models: ["chat-default", "unknown"] }, "conversation.chat"),
    ["chat-default"],
  );
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
    operation: "image.edit",
    pendingRecovery: { sourceRunId: "run-1", recoveryMode: "retry", operation: "image.edit" },
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
  assert.equal(readConversationDraft(second, "conversation-1").operation, "image.edit");
  assert.equal(readConversationDraft(second, "conversation-1").pendingRecovery.sourceRunId, "run-1");
  assert.equal(readConversationDraft(second, "conversation-2").value, "会话二草稿");
  assert.equal(readConversationDraft(second, "conversation-2").operation, "auto");

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

/** 验证会话工作台按归档、标题、时间与窗口组合筛选。 */
function testConversationWorkspace() {
  const conversations = [
    { id: "today", title: "平台方案", updatedAt: "2026-07-30T08:00:00.000Z", archivedAt: null },
    { id: "yesterday", title: "平台回归", updatedAt: "2026-07-29T08:00:00.000Z", archivedAt: null },
    { id: "week", title: "其他主题", updatedAt: "2026-07-26T08:00:00.000Z", archivedAt: null },
    { id: "archived", title: "平台旧稿", updatedAt: "2026-07-01T08:00:00.000Z", archivedAt: "2026-07-02T00:00:00.000Z" },
  ];
  const active = buildConversationWorkspace(conversations, {
    query: "平台",
    filter: "active",
    limit: 1,
    now: "2026-07-30T12:00:00.000Z",
  });
  assert.equal(active.total, 2);
  assert.equal(active.hasMore, true);
  assert.equal(active.conversations[0].id, "today");
  assert.equal(active.conversations[0].timeGroup, "今天");
  const all = buildConversationWorkspace(conversations, {
    filter: "all",
    limit: 10,
    now: "2026-07-30T12:00:00.000Z",
  });
  // 读取每条会话的时间组，验证固定分组顺序。
  assert.deepEqual(all.conversations.map((item) => item.timeGroup), ["今天", "昨天", "最近 7 天", "更早"]);
  assert.deepEqual(
    buildConversationWorkspace(conversations, { filter: "archived", limit: 10 }).conversations.map(
      // 读取归档筛选结果的稳定 ID，验证只返回具有 archivedAt 的会话。
      (item) => item.id,
    ),
    ["archived"],
  );
}

/** 验证草稿会话级持久化不会把本地图片 data URL 写入 sessionStorage。 */
function testSessionConversationDrafts() {
  const drafts = new Map([
    ["conversation-1", {
      value: "待发送",
      attachments: [
        { uid: "local", kind: "image", url: "data:image/png;base64,SECRET" },
        {
          uid: "stable",
          kind: "image",
          url: "/api/runtime/conversations/conversation-1/image-assets/asset-1/content",
          assetId: "asset-1",
        },
      ],
      references: [{ messageId: "message-1" }],
      model: "chat-default",
      operation: "image.edit",
      pendingRecovery: null,
    }],
  ]);
  const serialized = serializeConversationDrafts(drafts);
  assert.equal(serialized.includes("SECRET"), false);
  assert.equal(JSON.parse(serialized).version, 3);
  const restored = readConversationDraft(deserializeConversationDrafts(serialized), "conversation-1");
  assert.equal(restored.value, "待发送");
  assert.equal(restored.operation, "image.edit");
  // 恢复结果只保留可持久化的稳定资产附件。
  assert.deepEqual(restored.attachments.map((item) => item.uid), ["stable"]);
  assert.equal(restored.attachments[0].assetId, "asset-1");
  const legacy = readConversationDraft(deserializeConversationDrafts(JSON.stringify({
    version: 1,
    entries: [["legacy", { value: "旧草稿", attachments: [], references: [], model: "chat-default" }]],
  })), "legacy");
  assert.equal(legacy.operation, "conversation.chat");
  assert.equal(readConversationDraft(new Map(), "new-conversation").operation, "auto");
  const emptyAuto = serializeConversationDrafts(new Map([
    ["auto", { value: "", attachments: [], references: [], model: "", operation: "auto" }],
  ]));
  assert.equal(readConversationDraft(deserializeConversationDrafts(emptyAuto), "auto").operation, "auto");
  assert.equal(deserializeConversationDrafts("not-json").size, 0);
}

/** 验证智能模式只把唯一兼容本地图片或稳定资产提升为受控 image_asset。 */
function testAutoImageAssetSelection() {
  const png = { uid: "png", kind: "image", url: "data:image/png;base64,AAAA" };
  const jpeg = { uid: "jpeg", kind: "image", url: "data:image/jpeg;base64,AAAA" };
  const webp = { uid: "webp", kind: "image", url: "data:image/webp;base64,AAAA" };
  const gif = { uid: "gif", kind: "image", url: "data:image/gif;base64,AAAA" };
  const stable = { uid: "stable", kind: "image", assetId: "asset-1", url: "/assets/asset-1" };
  const remote = { uid: "remote", kind: "image", url: "https://example.com/source.png" };
  assert.equal(selectAutoImageAssetSource({ operation: "auto", attachments: [png], references: [] }), png);
  assert.equal(selectAutoImageAssetSource({ operation: "auto", attachments: [jpeg], references: [] }), jpeg);
  assert.equal(selectAutoImageAssetSource({ operation: "auto", attachments: [webp], references: [] }), webp);
  assert.equal(selectAutoImageAssetSource({ operation: "auto", attachments: [stable], references: [] }), stable);
  assert.equal(selectAutoImageAssetSource({ operation: "auto", attachments: [gif], references: [] }), null);
  assert.equal(selectAutoImageAssetSource({ operation: "auto", attachments: [remote], references: [] }), null);
  assert.equal(selectAutoImageAssetSource({ operation: "auto", attachments: [png, remote], references: [] }), null);
  assert.equal(selectAutoImageAssetSource({
    operation: "auto",
    attachments: [png],
    references: [{ type: "conversation_message", messageId: "message-1" }],
  }), null);
  assert.equal(selectAutoImageAssetSource({ operation: "image.edit", attachments: [png], references: [] }), null);
}

/** 验证只有带稳定身份的生成或编辑产物可以进入下一轮图片编辑。 */
function testEditableImageArtifactSelection() {
  assert.deepEqual(selectEditableImageArtifact({
    artifacts: [
      { type: "image_asset", assetId: "uploaded", source: "uploaded" },
      { type: "image_asset", assetId: "edited", source: "edited", url: "/assets/edited" },
    ],
  }), {
    type: "image_asset",
    assetId: "edited",
    source: "edited",
    url: "/assets/edited",
  });
  assert.equal(selectEditableImageArtifact({ artifacts: [{ type: "image_asset", source: "generated" }] }), null);
}

/** 验证长消息窗口、Markdown 标题与安全链接判断可确定回归。 */
function testLongAnswerViewModel() {
  // 用稳定递增 ID 构造长消息窗口 fixture。
  const messages = Array.from({ length: 5 }, (_, index) => ({ id: `message-${index + 1}` }));
  assert.deepEqual(buildMessageWindow(messages, 2), {
    messages: [{ id: "message-4" }, { id: "message-5" }],
    hiddenCount: 3,
    hasMore: true,
  });
  assert.deepEqual(extractMarkdownHeadings("# 方案\n## 验证\n## 验证", "message-1"), [
    { level: 1, title: "方案", id: "answer-heading-message-1-方案-1" },
    { level: 2, title: "验证", id: "answer-heading-message-1-验证-1" },
    { level: 2, title: "验证", id: "answer-heading-message-1-验证-2" },
  ]);
  assert.equal(isSafeMarkdownHref("https://example.com"), true);
  assert.equal(isSafeMarkdownHref("/docs/start"), true);
  assert.equal(isSafeMarkdownHref("javascript:alert(1)"), false);
  assert.equal(isSafeMarkdownHref("data:text/html,unsafe"), false);
}

/** 验证长会话跟随阈值和活动 Run 状态只映射已有渠道事实。 */
function testConversationProgressModel() {
  assert.equal(isMessageListAtLatest(0), true);
  assert.equal(isMessageListAtLatest(-20), true);
  assert.equal(isMessageListAtLatest(-25), false);
  assert.equal(activeRunStageLabel("starting", false), "正在连接模型");
  assert.equal(activeRunStageLabel("running", false), "正在等待模型响应");
  assert.equal(activeRunStageLabel("running", true), "正在生成回答");
  assert.equal(activeRunStageLabel("reconciling", false), "正在确认运行结果");
  assert.equal(activeRunStageLabel("tool-running", false, "实时天气"), "正在查询实时天气");
  assert.equal(activeRunStageLabel("image-uploading", false), "正在上传源图片");
  assert.equal(activeRunStageLabel("image-editing", false), "正在编辑图片");
  assert.equal(activeRunStageLabel("stopping", true), "正在停止生成");
  assert.equal(activeRunStatusForOperation("conversation.chat"), "running");
  assert.equal(activeRunStatusForOperation("image.generate"), "image-generating");
  assert.equal(activeRunStatusForOperation("image.edit"), "image-editing");
  assert.equal(activeRunStatusForOperation("auto"), "running");
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
test("Demo component keeps reconciling after the stalled threshold", testRunReconciliationAfterStalledThreshold);
test("Demo component does not infer absence from reconciliation read failures", testRunReconciliationIgnoresReadFailures);
test("Demo Adapter maps cancelled POST SSE", testCancelledRunStream);
test("Demo Adapter maps error POST SSE", testErrorRunStream);
test("Demo Adapter preserves JSON resource paths", testJsonResourceMapping);
test("Demo Adapter uploads a controlled image asset as binary", testImageAssetUploadMapping);
test("Demo Adapter cancels an in-flight image upload", testImageAssetUploadCancellation);
test("Demo Adapter times out a stalled image upload", testImageAssetUploadTimeout);
test("Demo view model persists the latest failed Run marker", testLatestRunFailureMarker);
test("Demo view model maps safe run failure feedback", testRunFailureCopy);
test("Demo view model recovers failed Run input", testRecoverRunInput);
test("Demo view model guards asynchronous image preparation", testImageAttachmentPreparationGuards);
test("Demo view model guards submission and labels lifecycle", testChannelStatusModel);
test("Demo view model builds conversation anchors", testConversationAnchors);
test("Demo view model isolates conversation drafts", testConversationDraftIsolation);
test("Demo view model builds the conversation workspace", testConversationWorkspace);
test("Demo view model persists session-safe drafts", testSessionConversationDrafts);
test("Demo view model selects controlled sources for smart mode", testAutoImageAssetSelection);
test("Demo view model selects stable image artifacts for continued editing", testEditableImageArtifactSelection);
test("Demo view model windows long answers safely", testLongAnswerViewModel);
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

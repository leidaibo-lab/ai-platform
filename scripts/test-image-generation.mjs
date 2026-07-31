#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayClient } from "../src/gateway/gateway-client.mjs";
import { createChatRuntime } from "../src/runtime/chat-runtime.mjs";
import { createConversationCoordinator } from "../src/runtime/conversation-coordinator.mjs";
import { createContextPlanner } from "../src/runtime/context-planner.mjs";
import { estimateMessagesTokens } from "../src/runtime/context-budget.mjs";
import { createMemoryManager } from "../src/runtime/memory-manager.mjs";
import { createConversationStore } from "../src/storage/conversation-store.mjs";
import { ImageAssetStoreError, createLocalImageAssetStore } from "../src/storage/image-asset-store.mjs";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const contextOptions = {
  maxContextTokens: 800,
  reservedOutputTokens: 120,
  safetyTokens: 80,
  highWatermarkRatio: 0.75,
  lowWatermarkRatio: 0.45,
  hardWatermarkRatio: 0.9,
};

/** 验证图片 Run 先形成资产事实，并在相同 requestId 重放时不再次调用模型。 */
async function testImageGenerationPersistenceAndReplay() {
  const fixture = createImageRuntimeFixture();
  try {
    const conversation = fixture.runtime.createConversation();
    const input = {
      operation: "image.generate",
      requestId: "image-request-1",
      clientMessageId: "image-message-1",
      model: "image-default",
      message: "生成一枚红色印章",
      imageOptions: { size: "1024x1024" },
    };
    const deliveredArtifacts = [];
    /** 记录 Runtime 在完成事件前交付的图片资产引用。 */
    function recordArtifact(artifact) {
      deliveredArtifacts.push(artifact);
    }

    const first = await fixture.runtime.runConversation(conversation.id, input, {
      onArtifactCreated: recordArtifact,
    });
    const replay = await fixture.runtime.runConversation(conversation.id, input);
    const detail = fixture.runtime.getConversation(conversation.id);
    const stored = fixture.store.readImageAsset(conversation.id, first.artifacts[0].assetId);
    const bytes = await fixture.imageAssetStore.read(stored.storageKey);

    assert.equal(fixture.gatewayClient.getImageCalls(), 1);
    assert.equal(first.operation, "image.generate");
    assert.equal(first.artifacts.length, 1);
    assert.deepEqual(replay.artifacts, first.artifacts);
    assert.equal(replay.replayed, true);
    assert.equal(deliveredArtifacts[0].assetId, first.artifacts[0].assetId);
    assert.equal(detail.latestRun.operation, "image.generate");
    assert.equal(detail.messages.at(-1).artifacts[0].assetId, first.artifacts[0].assetId);
    assert.equal(detail.messages.at(-1).content, "已生成 1 张图片");
    assert.deepEqual(bytes, PNG_BYTES);
    assert.equal(first.resilience.maxAttempts, 1);
  } finally {
    fixture.close();
  }
}

test("image generation persists assets and replays without another model call", testImageGenerationPersistenceAndReplay);

/** 验证平台在图片模型调用前拒绝未知尺寸和 provider 专属参数。 */
async function testImageGenerationOptionAllowlist() {
  const fixture = createImageRuntimeFixture();
  try {
    const conversation = fixture.runtime.createConversation();
    await assert.rejects(
      fixture.runtime.runConversation(conversation.id, {
        operation: "image.generate",
        requestId: "image-invalid-request",
        clientMessageId: "image-invalid-message",
        message: "生成测试图片",
        imageOptions: { quality: "hd", size: "2048x2048" },
      }),
      /** 只接受 Runtime 的稳定白名单错误。 */
      function matchesUnsupportedOption(error) {
        return error?.payload?.code === "unsupported_image_option";
      },
    );
    assert.equal(fixture.gatewayClient.getImageCalls(), 0);
    assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 0);
  } finally {
    fixture.close();
  }
}

test("image generation rejects non-whitelisted options before model invocation", testImageGenerationOptionAllowlist);

/** 验证图片生成取消只收口原 Run，不写入助手消息或图片资产。 */
async function testImageGenerationCancellation() {
  const gatewayClient = createCancellableImageGateway();
  const fixture = createImageRuntimeFixture({ gatewayClient });
  try {
    const conversation = fixture.runtime.createConversation();
    let runId = null;
    /** 保存 Runtime 已创建的 Run ID，供测试调用显式取消。 */
    function recordRunStarted({ run }) {
      runId = run.id;
    }
    const resultPromise = fixture.runtime.runConversation(conversation.id, {
      operation: "image.generate",
      requestId: "image-cancel-request",
      clientMessageId: "image-cancel-message",
      message: "生成一张等待取消的图片",
    }, { onRunStarted: recordRunStarted });
    await gatewayClient.waitUntilGenerating();
    const cancelled = fixture.runtime.cancelConversationRun(conversation.id, runId);
    const result = await resultPromise;
    const detail = fixture.runtime.getConversation(conversation.id);

    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(result.cancelled, true);
    assert.equal(gatewayClient.getImageCalls(), 1);
    assert.equal(detail.latestRun.operation, "image.generate");
    assert.equal(detail.latestRun.status, "cancelled");
    assert.equal(detail.latestRun.artifacts.length, 0);
    assert.deepEqual(detail.messages.map(readMessageRole), ["user"]);
  } finally {
    fixture.close();
  }
}

test("image generation cancellation persists no deliverable asset", testImageGenerationCancellation);

/** 验证图片调用耗尽 Run 截止时间时按 504 失败收口，而不是误记为用户取消。 */
async function testImageGenerationTimeout() {
  let imageCalls = 0;
  /** 等待 GatewayClient 的内部超时信号，并模拟 AI SDK 抛出对应 TimeoutError。 */
  async function generateTimedOutImage({ abortSignal, maxRetries }) {
    imageCalls += 1;
    assert.equal(maxRetries, 0);
    const keepAliveTimer = setTimeout(ignoreTimeoutKeepAlive, 1000);
    try {
      await waitForAbort(abortSignal);
    } finally {
      clearTimeout(keepAliveTimer);
    }
    throw abortSignal.reason || new DOMException("Image generation timed out", "TimeoutError");
  }
  const gatewayClient = createGatewayClient(
    {
      baseUrl: "http://gateway.test",
      model: "chat-default",
      imageModel: "image-default",
      apiKey: "test-key",
    },
    { generateImageImplementation: generateTimedOutImage },
  );
  const fixture = createImageRuntimeFixture({
    gatewayClient,
    resilienceOptions: { runTimeoutMs: 25 },
  });
  try {
    const conversation = fixture.runtime.createConversation();
    let failure = null;
    try {
      await fixture.runtime.runConversation(conversation.id, {
        operation: "image.generate",
        requestId: "image-timeout-request",
        clientMessageId: "image-timeout-message",
        message: "生成一张会超时的图片",
      });
    } catch (error) {
      failure = error;
    }
    const detail = fixture.runtime.getConversation(conversation.id);

    assert.equal(failure?.status, 504);
    assert.equal(failure?.payload?.code, "model_timeout");
    assert.equal(imageCalls, 1);
    assert.equal(detail.latestRun.status, "failed");
    assert.equal(detail.latestRun.error, "模型响应超时");
    assert.equal(detail.latestRun.resilience.maxAttempts, 1);
    assert.deepEqual(detail.messages.map(readMessageRole), ["user"]);
  } finally {
    fixture.close();
  }
}

test("image generation timeout is a 504 failure instead of cancellation", testImageGenerationTimeout);

/** 保持 Node 测试事件循环，直到 `AbortSignal.timeout()` 的 unref 计时器触发。 */
function ignoreTimeoutKeepAlive() {}

/** 验证图片已返回但资产存储失败时 Run 明确失败且不再次调用模型。 */
async function testImageAssetWriteFailure() {
  const gatewayClient = createImageGateway();
  const failingStore = {
    /** 模拟本地资产目录不可写。 */
    async write() {
      throw new ImageAssetStoreError("图片资产写入失败", "image_asset_write_failed");
    },
    /** 失败发生在稳定 storageKey 产生前，因此清理保持幂等空操作。 */
    async delete() {},
  };
  const fixture = createImageRuntimeFixture({ gatewayClient, imageAssetStore: failingStore });
  try {
    const conversation = fixture.runtime.createConversation();
    await assert.rejects(
      fixture.runtime.runConversation(conversation.id, {
        operation: "image.generate",
        requestId: "image-store-failure-request",
        clientMessageId: "image-store-failure-message",
        message: "生成后模拟保存失败",
      }),
      /** 只接受 Runtime 的稳定资产写入错误。 */
      function matchesAssetWriteFailure(error) {
        return error?.payload?.code === "image_asset_write_failed";
      },
    );
    const detail = fixture.runtime.getConversation(conversation.id);
    assert.equal(gatewayClient.getImageCalls(), 1);
    assert.equal(detail.latestRun.status, "failed");
    assert.equal(detail.latestRun.artifacts.length, 0);
    assert.deepEqual(detail.messages.map(readMessageRole), ["user"]);
  } finally {
    fixture.close();
  }
}

test("image asset write failure does not repeat image generation", testImageAssetWriteFailure);

/** 创建带真实 SQLite 和本地 ImageAssetStore、脚本图片模型的 C2 测试装配。 */
function createImageRuntimeFixture({
  gatewayClient = createImageGateway(),
  imageAssetStore: providedAssetStore,
  resilienceOptions,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ai-platform-image-generation-"));
  const store = createConversationStore({ databasePath: join(directory, "conversation.sqlite") });
  const imageAssetStore = providedAssetStore || createLocalImageAssetStore({ directory: join(directory, "assets") });
  const contextPlanner = createContextPlanner({
    store,
    gatewayClient,
    contextOptions,
    systemPrompt: "测试助手",
  });
  const memoryManager = createMemoryManager({ store, gatewayClient, contextOptions });
  const runtime = createChatRuntime({
    gatewayClient,
    contextOptions,
    store,
    coordinator: createConversationCoordinator(),
    contextPlanner,
    memoryManager,
    imageAssetStore,
    resilienceOptions,
  });
  return {
    store,
    imageAssetStore,
    gatewayClient,
    runtime,
    /** 关闭 SQLite 并清理本次测试的全部临时资产。 */
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** 创建等待 AbortSignal 的图片 Gateway，供取消边界回归。 */
function createCancellableImageGateway() {
  let imageCalls = 0;
  let resolveGenerating;
  const generating = new Promise((resolve) => {
    resolveGenerating = resolve;
  });
  return {
    model: "chat-default",
    imageModel: "image-default",
    /** 返回 Context Planner 兼容的固定 token 数。 */
    async countTokens() {
      return { tokens: 1, source: "scripted", model: this.model };
    },
    /** 保留完整 GatewayClient 文本方法。 */
    async chatCompletions() {
      return { model: this.model, usage: null, choices: [{ message: { content: "文本回复" } }] };
    },
    /** 返回当前服务端图片模型别名。 */
    async resolveImageModel(requestedModel) {
      return String(requestedModel || this.imageModel);
    },
    /** 开始调用后等待 Runtime 传播取消信号。 */
    async generateImages({ abortSignal }) {
      imageCalls += 1;
      resolveGenerating();
      await waitForAbort(abortSignal);
      throw abortSignal.reason || new DOMException("Image generation aborted", "AbortError");
    },
    /** 等待图片模型调用已经开始。 */
    waitUntilGenerating() {
      return generating;
    },
    /** 返回图片模型实际调用次数。 */
    getImageCalls() {
      return imageCalls;
    },
  };
}

/** 等待 AbortSignal 终止，已取消时立即完成。 */
function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    /** 收到首次取消后结束等待。 */
    function handleAbort() {
      resolve();
    }
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

/** 读取消息角色，供不存在助手产物的断言复用。 */
function readMessageRole(message) {
  return message.role;
}

/** 创建只记录图片调用次数的脚本化 GatewayClient。 */
function createImageGateway() {
  let imageCalls = 0;
  return {
    model: "chat-default",
    imageModel: "image-default",
    /** 文本上下文测试所需的确定性 token counter。 */
    async countTokens({ messages }) {
      return { tokens: estimateMessagesTokens(messages), source: "scripted", model: this.model };
    },
    /** 默认聊天方法仅用于满足完整 GatewayClient Port。 */
    async chatCompletions() {
      return { model: this.model, usage: null, choices: [{ message: { content: "文本回复" } }] };
    },
    /** 返回服务端配置的图片模型别名。 */
    async resolveImageModel(requestedModel) {
      return String(requestedModel || this.imageModel);
    },
    /** 返回固定 PNG 和单次尝试证据，不接触真实上游。 */
    async generateImages({ model, size }) {
      imageCalls += 1;
      assert.equal(size, "1024x1024");
      return {
        model,
        images: [{ bytes: PNG_BYTES, mediaType: "image/png" }],
        usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12, generated_images: 1 },
        resilience: {
          operation: "model.image.generate",
          maxAttempts: 1,
          attemptCount: 1,
          retryBoundaryCrossed: true,
          attempts: [{ attempt: 1, status: "completed", willRetry: false }],
        },
      };
    },
    /** 返回真实图片模型调用次数，供幂等重放断言。 */
    getImageCalls() {
      return imageCalls;
    },
  };
}

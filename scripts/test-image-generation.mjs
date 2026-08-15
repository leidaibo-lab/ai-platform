#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GatewayRequestError, createGatewayClient } from "../src/gateway/gateway-client.mjs";
import { createChatRuntime } from "../src/runtime/chat-runtime.mjs";
import { createConversationCoordinator } from "../src/runtime/conversation-coordinator.mjs";
import { createContextPlanner } from "../src/runtime/context-planner.mjs";
import { estimateMessagesTokens } from "../src/runtime/context-budget.mjs";
import { createMemoryManager } from "../src/runtime/memory-manager.mjs";
import { createRunEventSink } from "../src/runtime/run-event-sink.mjs";
import { createConversationStore } from "../src/storage/conversation-store.mjs";
import { ImageAssetStoreError, createLocalImageAssetStore } from "../src/storage/image-asset-store.mjs";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const TRUNCATED_PNG_BYTES = PNG_BYTES.subarray(0, PNG_BYTES.length - 1);
const TRUNCATED_JPEG_BYTES = Buffer.from("ffd8ffc00011080001000103011100021100031100", "hex");
const TRUNCATED_WEBP_BYTES = Buffer.from(
  "524946461e00000057454250565038580a00000000000000000000000000",
  "hex",
);
const EMPTY_IDAT_PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000000000000000000049444154000000000000000049454e4400000000",
  "hex",
);
const VP8X_ONLY_WEBP_BYTES = Buffer.from(
  "524946461600000057454250565038580a00000000000000000000000000",
  "hex",
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
    function recordArtifact(event) {
      if (event.type === "artifact.created") deliveredArtifacts.push(event.artifact);
    }
    /** 模拟图片资产事件订阅者失败，验证旁路异常不污染已提交 Run。 */
    function rejectArtifactObservation(event) {
      if (event.type === "artifact.created") throw new Error("intentional artifact subscriber failure");
    }

    const first = await fixture.runtime.runConversation(conversation.id, input, {
      eventSink: createRunEventSink({ subscribers: [recordArtifact, rejectArtifactObservation] }),
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
    assert.ok(fixture.store.getRunLease(detail.latestRun.id).releasedAt);
  } finally {
    fixture.close();
  }
}

test("image generation persists assets and replays without another model call", testImageGenerationPersistenceAndReplay);

/** 验证上传源资产、图片编辑结果和幂等重放形成独立且可追溯的会话事实。 */
async function testImageEditingPersistenceAndReplay() {
  const fixture = createImageRuntimeFixture();
  try {
    const conversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(conversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    const input = {
      operation: "image.edit",
      requestId: "image-edit-request-1",
      clientMessageId: "image-edit-message-1",
      model: "image-default",
      message: "保留构图并改成蓝色水彩风格",
      references: [{ type: "image_asset", assetId: source.assetId }],
      imageOptions: { size: "1024x1024" },
    };

    const first = await fixture.runtime.runConversation(conversation.id, input);
    const readStoredImage = fixture.imageAssetStore.read.bind(fixture.imageAssetStore);
    const resolveImageModel = fixture.gatewayClient.resolveImageModel;
    /** 若完成态幂等重放错误读取源文件，则用明确异常使测试失败。 */
    async function rejectReplaySourceRead() {
      throw new Error("completed replay must not read the source image");
    }
    /** 若完成态幂等重放错误查询当前模型目录，则用明确异常使测试失败。 */
    async function rejectReplayModelResolution() {
      throw new Error("completed replay must not resolve the current model");
    }
    fixture.imageAssetStore.read = rejectReplaySourceRead;
    fixture.gatewayClient.resolveImageModel = rejectReplayModelResolution;
    const replay = await fixture.runtime.runConversation(conversation.id, input);
    fixture.imageAssetStore.read = readStoredImage;
    fixture.gatewayClient.resolveImageModel = resolveImageModel;
    const second = await fixture.runtime.runConversation(conversation.id, {
      operation: "image.edit",
      requestId: "image-edit-request-2",
      clientMessageId: "image-edit-message-2",
      model: "image-default",
      message: "继续保留构图并调亮背景",
      references: [{ type: "image_asset", assetId: first.artifacts[0].assetId }],
      imageOptions: { size: "1024x1024" },
    });
    const detail = fixture.runtime.getConversation(conversation.id);
    const sourceStored = fixture.store.readImageAsset(conversation.id, source.assetId);
    const editedStored = fixture.store.readImageAsset(conversation.id, first.artifacts[0].assetId);
    const secondEditedStored = fixture.store.readImageAsset(conversation.id, second.artifacts[0].assetId);
    const editSources = fixture.gatewayClient.getEditSources();
    const editResults = fixture.gatewayClient.getEditResults();

    assert.equal(source.source, "uploaded");
    assert.equal(source.runId, null);
    assert.equal(first.operation, "image.edit");
    assert.equal(first.artifacts[0].source, "edited");
    assert.notEqual(first.artifacts[0].assetId, source.assetId);
    assert.notEqual(second.artifacts[0].assetId, first.artifacts[0].assetId);
    assert.deepEqual(replay.artifacts, first.artifacts);
    assert.equal(replay.replayed, true);
    assert.equal(fixture.gatewayClient.getEditCalls(), 2);
    assert.deepEqual(editSources, [PNG_BYTES, editResults[0]]);
    assert.deepEqual(await fixture.imageAssetStore.read(sourceStored.storageKey), PNG_BYTES);
    assert.deepEqual(await fixture.imageAssetStore.read(editedStored.storageKey), editResults[0]);
    assert.deepEqual(await fixture.imageAssetStore.read(secondEditedStored.storageKey), editResults[1]);
    assert.deepEqual(detail.messages[0].references, [{ type: "image_asset", assetId: source.assetId }]);
    assert.equal(detail.messages[0].referenceAssets[0].assetId, source.assetId);
    assert.deepEqual(detail.messages[2].references, [{ type: "image_asset", assetId: first.artifacts[0].assetId }]);
    assert.equal(detail.messages.at(-1).content, "已编辑 1 张图片");
    assert.equal(first.resilience.operation, "model.image.edit");
  } finally {
    fixture.close();
  }
}

test("image editing uses a controlled source asset and replays without another edit", testImageEditingPersistenceAndReplay);

/** 验证 auto 单图输入以高置信度解析为编辑，并把真实 operation 写入 Run。 */
async function testAutoRoutesControlledImageToEditing() {
  let routingCalls = 0;
  const policyContexts = [];
  const runStartedEvents = [];
  /** 记录自动路由后交付给渠道的真实 Run operation。 */
  function recordRunStarted(event) {
    if (event.type === "run.started") runStartedEvents.push(event);
  }
  const intentRouter = {
    /** 把当前单图优化指令解析为高置信图片编辑。 */
    async resolve() {
      routingCalls += 1;
      return {
        operation: "image.edit",
        confidence: 0.97,
        source: "structured-classifier",
        candidates: ["conversation.chat", "image.edit"],
      };
    },
  };
  const executionPolicy = {
    /** 记录 Runtime 交给策略的真实 operation，并允许当前受限图片切片。 */
    async evaluateBefore(context) {
      policyContexts.push(context);
      return {
        decision: "allow",
        policy: "image-test-policy",
        policyVersion: "image-test-policy.v1",
        reasonCodes: ["resolved_image_operation_allowed"],
        evaluatedAt: "2026-08-15T00:00:00.000Z",
        hookErrors: [],
      };
    },
    /** 当前测试不装配后置策略观察器。 */
    async observeAfter() {
      return { attempted: 0, completed: 0, failedHooks: [] };
    },
  };
  const fixture = createImageRuntimeFixture({ intentRouter, executionPolicy });
  try {
    const conversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(conversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    const result = await fixture.runtime.runConversation(
      conversation.id,
      {
        operation: "auto",
        requestId: "auto-image-edit-request",
        clientMessageId: "auto-image-edit-message",
        message: "保留主体，把背景优化为干净的浅蓝色",
        references: [{ type: "image_asset", assetId: source.assetId }],
      },
      { eventSink: createRunEventSink({ subscribers: [recordRunStarted] }) },
    );
    const detail = fixture.runtime.getConversation(conversation.id);

    assert.equal(result.operation, "image.edit");
    assert.equal(result.artifacts[0].source, "edited");
    assert.equal(detail.latestRun.operation, "image.edit");
    assert.equal(fixture.gatewayClient.getEditCalls(), 1);
    assert.equal(routingCalls, 1);
    assert.equal(policyContexts.length, 1);
    assert.equal(policyContexts[0].operation, "image.edit");
    assert.equal(policyContexts[0].effect, "write");
    assert.equal(policyContexts[0].riskLevel, "medium");
    assert.equal(policyContexts[0].known, true);
    assert.equal(runStartedEvents.length, 1);
    assert.equal(runStartedEvents[0].operation, "image.edit");
    assert.ok(fixture.store.getRunLease(detail.latestRun.id).releasedAt);
  } finally {
    fixture.close();
  }
}

test("auto routes one controlled image and an explicit optimization instruction to image editing", testAutoRoutesControlledImageToEditing);

/** 验证 auto 图片编辑在前置策略之后重新读取源图，并把该阶段校验的字节交给业务模型。 */
async function testAutoImageEditingRereadsSourceAfterPolicy() {
  let policyEvaluated = false;
  let readsAfterPolicy = 0;
  /** 标记分类和附件硬校验已经结束，后续读取才属于业务调用前校验。 */
  function markPolicyEvaluated() {
    policyEvaluated = true;
  }
  const intentRouter = {
    /** 将显式单图请求稳定解析为图片编辑。 */
    async resolve(_input, execution) {
      return buildTestIntentDecision({
        operation: "image.edit",
        confidence: 0.98,
        candidates: ["conversation.chat", "image.edit"],
        contextVersion: execution.routingContextSnapshot.conversationVersion,
      });
    },
  };
  const fixture = createImageRuntimeFixture({
    intentRouter,
    executionPolicy: createAllowingTestExecutionPolicy(markPolicyEvaluated),
  });
  try {
    const conversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(conversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    const readStoredImage = fixture.imageAssetStore.read.bind(fixture.imageAssetStore);
    /** 记录图片字节是否在 Run 前置策略之后再次从资产存储读取。 */
    fixture.imageAssetStore.read = async function trackBusinessImageRead(storageKey) {
      const bytes = await readStoredImage(storageKey);
      if (policyEvaluated) readsAfterPolicy += 1;
      return bytes;
    };

    const result = await fixture.runtime.runConversation(conversation.id, {
      operation: "auto",
      requestId: "auto-reread-edit-request",
      clientMessageId: "auto-reread-edit-message",
      message: "保持主体并提升背景对比度",
      references: [{ type: "image_asset", assetId: source.assetId }],
    });

    assert.equal(result.operation, "image.edit");
    assert.equal(readsAfterPolicy, 1);
    assert.deepEqual(fixture.gatewayClient.getEditSources(), [PNG_BYTES]);
  } finally {
    fixture.close();
  }
}

test("auto image editing re-reads controlled source bytes after policy evaluation", testAutoImageEditingRereadsSourceAfterPolicy);

/** 验证分类完成后源文件发生变化时，实际图片编辑调用前的完整性检查会阻止副作用。 */
async function testAutoImageEditingRejectsSourceChangedAfterRouting() {
  let sourcePath = "";
  /** 在分类和首次附件校验之后替换源文件，模拟业务调用前的存储变化。 */
  function replaceSourceAfterRouting() {
    writeFileSync(sourcePath, createVersionedPngFixture(17));
  }
  const intentRouter = {
    /** 将显式单图请求稳定解析为图片编辑。 */
    async resolve(_input, execution) {
      return buildTestIntentDecision({
        operation: "image.edit",
        confidence: 0.99,
        candidates: ["conversation.chat", "image.edit"],
        contextVersion: execution.routingContextSnapshot.conversationVersion,
      });
    },
  };
  const fixture = createImageRuntimeFixture({
    intentRouter,
    executionPolicy: createAllowingTestExecutionPolicy(replaceSourceAfterRouting),
  });
  try {
    const conversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(conversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    const stored = fixture.store.readImageAsset(conversation.id, source.assetId);
    sourcePath = join(fixture.assetDirectory, stored.storageKey);

    await assert.rejects(
      fixture.runtime.runConversation(conversation.id, {
        operation: "auto",
        requestId: "auto-changed-source-edit-request",
        clientMessageId: "auto-changed-source-edit-message",
        message: "保留布局并优化颜色",
        references: [{ type: "image_asset", assetId: source.assetId }],
      }),
      /** 只接受业务调用前重新读取产生的稳定完整性错误。 */
      function matchesChangedSourceIntegrityFailure(error) {
        return error?.payload?.code === "image_asset_integrity_mismatch";
      },
    );

    assert.equal(fixture.gatewayClient.getEditCalls(), 0);
    assert.equal(fixture.runtime.getConversation(conversation.id).latestRun.status, "failed");
  } finally {
    fixture.close();
  }
}

test("auto image editing rejects a source changed after routing and before invocation", testAutoImageEditingRejectsSourceChangedAfterRouting);

/** 验证 auto 视觉对话同样在前置策略后重读图片，并只把新鲜字节转换为本轮 data URL。 */
async function testAutoVisionChatRereadsSourceAfterPolicy() {
  let policyEvaluated = false;
  let readsAfterPolicy = 0;
  let generatedMessages = null;
  const gatewayClient = createImageGateway();
  /** 允许视觉对话解析默认模型。 */
  gatewayClient.resolveConversationModel = async function resolveConversationModel() {
    return this.model;
  };
  /** 捕获业务模型实际收到的多模态消息。 */
  gatewayClient.chatCompletions = async function captureVisionMessages({ messages }) {
    generatedMessages = messages;
    return { model: this.model, usage: null, choices: [{ message: { content: "视觉结果" } }] };
  };
  /** 标记分类和附件硬校验已经结束。 */
  function markPolicyEvaluated() {
    policyEvaluated = true;
  }
  const intentRouter = {
    /** 将带图问题稳定解析为视觉对话。 */
    async resolve(_input, execution) {
      return buildTestIntentDecision({
        operation: "conversation.chat",
        confidence: 0.97,
        candidates: ["conversation.chat", "image.edit"],
        contextVersion: execution.routingContextSnapshot.conversationVersion,
      });
    },
  };
  const fixture = createImageRuntimeFixture({
    gatewayClient,
    intentRouter,
    executionPolicy: createAllowingTestExecutionPolicy(markPolicyEvaluated),
  });
  try {
    const conversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(conversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    const readStoredImage = fixture.imageAssetStore.read.bind(fixture.imageAssetStore);
    /** 记录视觉业务调用使用的图片是否来自策略后的重新读取。 */
    fixture.imageAssetStore.read = async function trackVisionImageRead(storageKey) {
      const bytes = await readStoredImage(storageKey);
      if (policyEvaluated) readsAfterPolicy += 1;
      return bytes;
    };

    const result = await fixture.runtime.runConversation(conversation.id, {
      operation: "auto",
      requestId: "auto-reread-vision-request",
      clientMessageId: "auto-reread-vision-message",
      message: "这张图的主体是什么？",
      references: [{ type: "image_asset", assetId: source.assetId }],
    });
    const currentMessage = generatedMessages.at(-1);
    const imagePart = findImageUrlPart(currentMessage.content);

    assert.equal(result.operation, "conversation.chat");
    assert.equal(readsAfterPolicy, 1);
    assert.equal(imagePart.image_url.url, `data:image/png;base64,${PNG_BYTES.toString("base64")}`);
  } finally {
    fixture.close();
  }
}

test("auto vision chat re-reads controlled bytes before building its data URL", testAutoVisionChatRereadsSourceAfterPolicy);

/**
 * 验证 Runtime 从消息事实继承活动图片，并让视觉核查后的无附件请求继续产出新版本。
 * 路由脚本只按轮次返回结构化决定，断言对象来自真实 Store 快照而非前端附件续接。
 */
async function testContextAwareImageEditingWithoutCurrentAttachment() {
  const routingSnapshots = [];
  const intentRouter = {
    /** 按 fixture 轮次返回决定，同时保存生产 Runtime 实际提供的路由上下文。 */
    async resolve(_input, execution = {}) {
      const snapshot = execution.routingContextSnapshot;
      routingSnapshots.push(snapshot);
      const callIndex = routingSnapshots.length - 1;
      if (callIndex === 0) {
        return buildTestIntentDecision({
          operation: "image.edit",
          confidence: 0.98,
          candidates: ["conversation.chat", "image.edit"],
          contextVersion: snapshot.conversationVersion,
        });
      }
      if (callIndex === 1) {
        return buildTestIntentDecision({
          operation: "conversation.chat",
          confidence: 0.96,
          candidates: ["conversation.chat", "image.generate", "image.edit"],
          useActiveImage: true,
          relevantMessageIds: [snapshot.activeImage.anchorMessageId],
          contextVersion: snapshot.conversationVersion,
        });
      }
      const relevantMessageIds = snapshot.messages.slice(-2).map(readMessageId);
      return buildTestIntentDecision({
        operation: "image.edit",
        confidence: 0.95,
        candidates: ["conversation.chat", "image.generate", "image.edit"],
        useActiveImage: true,
        relevantMessageIds,
        contextVersion: snapshot.conversationVersion,
      });
    },
  };
  const fixture = createImageRuntimeFixture({ intentRouter });
  try {
    const conversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(conversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    const firstEdit = await fixture.runtime.runConversation(conversation.id, {
      operation: "auto",
      requestId: "context-edit-request-1",
      clientMessageId: "context-edit-message-1",
      message: "把标题颜色调整得更醒目",
      references: [{ type: "image_asset", assetId: source.assetId }],
    });
    const firstEditedAssetId = firstEdit.artifacts[0].assetId;
    const visualCheck = await fixture.runtime.runConversation(conversation.id, {
      operation: "auto",
      requestId: "context-visual-check-request",
      clientMessageId: "context-visual-check-message",
      message: "这个版本的颜色变化是否足够明显？",
    });
    const finalInput = {
      operation: "auto",
      requestId: "context-edit-request-2",
      clientMessageId: "context-edit-message-2",
      message: "请按照刚才的判断继续完善并输出新图",
    };
    const secondEdit = await fixture.runtime.runConversation(conversation.id, finalInput);
    const replay = await fixture.runtime.runConversation(conversation.id, finalInput);
    const detail = fixture.runtime.getConversation(conversation.id);
    const events = fixture.store.listEventsAfter(conversation.id);
    const editResults = fixture.gatewayClient.getEditResults();
    const editPrompts = fixture.gatewayClient.getEditPrompts();

    assert.equal(visualCheck.operation, "conversation.chat");
    assert.equal(secondEdit.operation, "image.edit");
    assert.equal(replay.replayed, true);
    assert.equal(routingSnapshots.length, 3);
    assert.equal(routingSnapshots[0].activeImage, null);
    assert.equal(routingSnapshots[1].activeImage.assetId, firstEditedAssetId);
    assert.equal(routingSnapshots[2].activeImage.assetId, firstEditedAssetId);
    assert.deepEqual(fixture.gatewayClient.getEditSources(), [PNG_BYTES, editResults[0]]);
    assert.match(editPrompts[1], /这个版本的颜色变化是否足够明显/u);
    assert.match(editPrompts[1], /请按照刚才的判断继续完善并输出新图/u);
    assert.deepEqual(detail.messages[2].references, [
      { type: "image_asset", assetId: firstEditedAssetId },
    ]);
    assert.deepEqual(detail.messages[4].references, [
      { type: "image_asset", assetId: firstEditedAssetId },
    ]);
    assert.equal(detail.latestRun.intentDecision.useActiveImage, true);
    assert.deepEqual(
      detail.latestRun.intentDecision.relevantMessageIds,
      routingSnapshots[2].messages.slice(-2).map(readMessageId),
    );
    assert.equal(detail.workingContext.activeImage.assetId, secondEdit.artifacts[0].assetId);
    assert.equal(
      events.filter(
        /** 只统计当前三次 auto Run 的脱敏路由审计事件。 */
        (event) => event.type === "run.intent_resolved",
      ).length,
      3,
    );
    assert.equal(fixture.gatewayClient.getEditCalls(), 2);
  } finally {
    fixture.close();
  }
}

test(
  "auto inherits the active image and relevant history without current attachments",
  testContextAwareImageEditingWithoutCurrentAttachment,
);

/** 验证长历史预算优先保留最近证据，且持久化 ID 与真正进入编辑 Prompt 的证据完全一致。 */
async function testContextualImageEditPromptAuditsOnlyUsedRecentEvidence() {
  let classifiedEvidenceIds = [];
  let classifiedEvidence = [];
  const intentRouter = {
    /** 从真实 Store 快照选择最近六条用户消息作为候选证据。 */
    async resolve(_input, execution) {
      const snapshot = execution.routingContextSnapshot;
      const userMessages = [];
      for (const message of snapshot.messages) {
        if (message.role === "user") userMessages.push(message);
      }
      classifiedEvidence = userMessages.slice(-6);
      classifiedEvidenceIds = classifiedEvidence.map(readMessageId);
      return buildTestIntentDecision({
        operation: "image.edit",
        confidence: 0.99,
        candidates: ["conversation.chat", "image.generate", "image.edit"],
        useActiveImage: true,
        relevantMessageIds: classifiedEvidenceIds,
        contextVersion: snapshot.conversationVersion,
        contextTruncated: snapshot.truncated,
      });
    },
  };
  const fixture = createImageRuntimeFixture({ intentRouter });
  try {
    const conversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(conversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    await fixture.runtime.runConversation(conversation.id, {
      operation: "image.edit",
      requestId: "evidence-base-edit-request",
      clientMessageId: "evidence-base-edit-message",
      message: "建立后续编辑所需的活动图片",
      references: [{ type: "image_asset", assetId: source.assetId }],
    });
    for (let index = 1; index <= 6; index += 1) {
      const marker = `证据-${String(index).padStart(2, "0")}`;
      seedCommittedConversationTurn({
        store: fixture.store,
        conversationId: conversation.id,
        index,
        userContent: `${marker}-${"甲".repeat(890)}`,
        assistantContent: `已记录 ${marker}`,
      });
    }
    const currentRequestPrefix = "依据最近讨论继续优化，";
    const currentRequestSuffix = "直接输出新的图片版本";
    const currentRequest = `${currentRequestPrefix}${"乙".repeat(
      4000 - currentRequestPrefix.length - currentRequestSuffix.length,
    )}${currentRequestSuffix}`;
    await fixture.runtime.runConversation(conversation.id, {
      operation: "auto",
      requestId: "bounded-evidence-edit-request",
      clientMessageId: "bounded-evidence-edit-message",
      message: currentRequest,
    });
    const detail = fixture.runtime.getConversation(conversation.id);
    const prompt = fixture.gatewayClient.getEditPrompts().at(-1);
    const auditedEvidenceIds = detail.latestRun.intentDecision.relevantMessageIds;
    const promptEvidenceIds = [];
    for (const message of classifiedEvidence) {
      const marker = String(message.displayContent).slice(0, "证据-00".length);
      if (prompt.includes(marker)) promptEvidenceIds.push(readMessageId(message));
    }

    assert.ok(prompt.length <= 4000);
    assert.ok(prompt.includes("当前请求（最高优先级，请以此为准）"));
    assert.equal(currentRequest.length, 4000);
    assert.ok(prompt.includes(currentRequestPrefix));
    assert.ok(prompt.includes("当前请求已按编辑 Prompt 预算截断"));
    assert.ok(prompt.endsWith(currentRequestSuffix));
    assert.ok(prompt.includes("证据-06"));
    assert.equal(prompt.includes("证据-01"), false);
    assert.ok(promptEvidenceIds.length < classifiedEvidenceIds.length);
    assert.deepEqual(auditedEvidenceIds, promptEvidenceIds);
    assert.equal(auditedEvidenceIds.at(-1), classifiedEvidenceIds.at(-1));
  } finally {
    fixture.close();
  }
}

test(
  "contextual image editing audits only recent evidence that fits the prompt budget",
  testContextualImageEditPromptAuditsOnlyUsedRecentEvidence,
);

/** 验证助手活动图片必须来自同会话 completed 图片 Run，而用户唯一受控附件不受该产物约束。 */
function testActiveImageRequiresConsistentAssistantFacts() {
  const directory = mkdtempSync(join(tmpdir(), "ai-platform-active-image-facts-"));
  const databasePath = join(directory, "conversation.sqlite");
  const store = createConversationStore({ databasePath });
  let database;
  try {
    const conversation = store.createConversation();
    const foreignConversation = store.createConversation();
    const started = store.startRun({
      conversationId: conversation.id,
      requestId: "active-image-source-request",
      clientMessageId: "active-image-source-message",
      content: "create a source image",
      displayContent: "create a source image",
      operation: "image.generate",
    });
    const assetId = "33333333-3333-4333-8333-333333333333";
    const completed = store.completeImageRun({
      runId: started.run.id,
      assets: [{
        assetId,
        storageKey: `${assetId}.png`,
        mediaType: "image/png",
        sizeBytes: PNG_BYTES.length,
        width: 1,
        height: 1,
        sha256: "active-image-sha256",
      }],
      displayContent: "image created",
      usage: null,
      model: "image-default",
      resilience: null,
    });
    const assistantMessageId = completed.assistantMessage.id;
    const userMessageId = started.userMessage.id;

    assert.equal(store.getRoutingContextSnapshot(conversation.id).activeImage.assetId, assetId);
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON");

    database.prepare("UPDATE messages SET status = 'interrupted' WHERE id = ?").run(assistantMessageId);
    assert.equal(store.getRoutingContextSnapshot(conversation.id).activeImage, null);
    database.prepare("UPDATE messages SET status = 'committed' WHERE id = ?").run(assistantMessageId);

    database.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(started.run.id);
    assert.equal(store.getRoutingContextSnapshot(conversation.id).activeImage, null);
    database.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(started.run.id);

    database.prepare("UPDATE runs SET operation = 'conversation.chat' WHERE id = ?").run(started.run.id);
    assert.equal(store.getRoutingContextSnapshot(conversation.id).activeImage, null);
    database.prepare("UPDATE runs SET operation = 'image.generate' WHERE id = ?").run(started.run.id);

    database.prepare("UPDATE runs SET assistant_message_id = ? WHERE id = ?").run(userMessageId, started.run.id);
    assert.equal(store.getRoutingContextSnapshot(conversation.id).activeImage, null);
    database.prepare("UPDATE runs SET assistant_message_id = ? WHERE id = ?").run(assistantMessageId, started.run.id);

    database.prepare("UPDATE image_assets SET run_id = NULL WHERE id = ?").run(assetId);
    assert.equal(store.getRoutingContextSnapshot(conversation.id).activeImage, null);
    database.prepare("UPDATE image_assets SET run_id = ? WHERE id = ?").run(started.run.id, assetId);

    database.prepare("UPDATE image_assets SET conversation_id = ? WHERE id = ?").run(foreignConversation.id, assetId);
    assert.equal(store.getRoutingContextSnapshot(conversation.id).activeImage, null);
    database.prepare("UPDATE image_assets SET conversation_id = ? WHERE id = ?").run(conversation.id, assetId);
    assert.equal(store.getRoutingContextSnapshot(conversation.id).activeImage.assetId, assetId);

    const attachmentConversation = store.createConversation();
    const uploadedAssetId = "44444444-4444-4444-8444-444444444444";
    store.createImageAsset({
      conversationId: attachmentConversation.id,
      asset: {
        assetId: uploadedAssetId,
        storageKey: `${uploadedAssetId}.png`,
        mediaType: "image/png",
        sizeBytes: PNG_BYTES.length,
        width: 1,
        height: 1,
        sha256: "uploaded-active-image-sha256",
      },
    });
    const attachmentRun = store.startRun({
      conversationId: attachmentConversation.id,
      requestId: "active-upload-request",
      clientMessageId: "active-upload-message",
      content: "modify the controlled image",
      displayContent: "modify the controlled image",
      references: [{ type: "image_asset", assetId: uploadedAssetId }],
      operation: "image.edit",
    });
    const attachmentSnapshot = store.getRoutingContextSnapshot(attachmentConversation.id);
    assert.equal(attachmentRun.run.status, "running");
    assert.equal(attachmentSnapshot.activeImage.assetId, uploadedAssetId);
    assert.equal(attachmentSnapshot.activeImage.source, "uploaded");
    assert.equal(attachmentSnapshot.activeImage.anchorMessageId, attachmentRun.userMessage.id);
  } finally {
    database?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test(
  "active image projection rejects inconsistent assistant artifacts but keeps controlled user attachments",
  testActiveImageRequiresConsistentAssistantFacts,
);

/** 创建包含路由版本和证据字段的脚本决定，保持与生产审计结构一致。 */
function buildTestIntentDecision({
  operation,
  confidence,
  candidates,
  useActiveImage = false,
  relevantMessageIds = [],
  contextVersion,
  contextTruncated = false,
}) {
  return {
    schemaVersion: "run-intent-decision.v2",
    routerVersion: "runtime-intent.v2",
    operation,
    classifiedOperation: operation,
    confidence,
    threshold: 0.85,
    source: "structured-classifier",
    candidates,
    useActiveImage,
    relevantMessageIds,
    contextVersion,
    contextStrategyVersion: "routing-context.v2",
    contextTruncated,
  };
}

/** 创建允许测试 operation 的最小执行策略，并在前置阶段运行指定观测动作。 */
function createAllowingTestExecutionPolicy(observeBefore) {
  return {
    /** 在返回 allow 决定前执行测试注入的同步观测或变更。 */
    async evaluateBefore(context) {
      await observeBefore(context);
      return {
        decision: "allow",
        policy: "image-test-policy",
        policyVersion: "image-test-policy.v1",
        reasonCodes: ["test_operation_allowed"],
        evaluatedAt: "2026-08-15T00:00:00.000Z",
        hookErrors: [],
      };
    },
    /** 当前测试策略不执行后置观察。 */
    async observeAfter() {
      return { attempted: 0, completed: 0, failedHooks: [] };
    },
  };
}

/** 从 OpenAI-compatible 多模态 content 中读取首个图片 URL part。 */
function findImageUrlPart(content) {
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "image_url") return part;
  }
  return null;
}

/** 读取路由快照消息 ID，供 fixture 证据选择和持久化断言共用。 */
function readMessageId(message) {
  return String(message?.id || "");
}

/** 直接通过 Store Port 写入一组 completed 对话消息，避免长证据 fixture 触发无关的记忆压缩。 */
function seedCommittedConversationTurn({ store, conversationId, index, userContent, assistantContent }) {
  const started = store.startRun({
    conversationId,
    requestId: `evidence-seed-request-${index}`,
    clientMessageId: `evidence-seed-message-${index}`,
    content: userContent,
    displayContent: userContent,
    model: "chat-default",
    operation: "conversation.chat",
  });
  const ownerId = `evidence-seed-owner-${index}`;
  const acquired = store.acquireRunLease({
    runId: started.run.id,
    conversationId,
    ownerId,
    ttlMs: 60_000,
  });
  assert.equal(acquired.acquired, true);
  store.completeRun({
    runId: started.run.id,
    content: assistantContent,
    displayContent: assistantContent,
    usage: null,
    contextManifest: {},
    model: "chat-default",
    resilience: null,
    lease: {
      ownerId,
      fencingToken: acquired.lease.fencingToken,
    },
  });
}

/** 验证启动恢复明确拒绝图片生成和编辑，不把遗留 running Run 重放为第二次图片副作用。 */
async function testImageRunsAreNotRestartRecovered() {
  const fixture = createImageRuntimeFixture();
  try {
    const generationConversation = fixture.runtime.createConversation();
    fixture.store.startRun({
      conversationId: generationConversation.id,
      requestId: "restart-image-generate-request",
      clientMessageId: "restart-image-generate-message",
      content: "生成一张图片",
      displayContent: "生成一张图片",
      model: "image-default",
      operation: "image.generate",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      chainTraceId: "restart-image-generate-trace",
    });

    const editingConversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(editingConversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    fixture.store.startRun({
      conversationId: editingConversation.id,
      requestId: "restart-image-edit-request",
      clientMessageId: "restart-image-edit-message",
      content: "优化这张图片",
      displayContent: "优化这张图片",
      references: [{ type: "image_asset", assetId: source.assetId }],
      model: "image-default",
      operation: "image.edit",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      chainTraceId: "restart-image-edit-trace",
    });

    const recovery = await fixture.runtime.recoverInterruptedRuns();

    assert.equal(recovery.scanned, 2);
    assert.equal(recovery.failed, 2);
    assert.deepEqual(recovery.outcomes.map(readRecoveryReason), [
      "run_operation_not_recoverable",
      "run_operation_not_recoverable",
    ]);
    assert.equal(fixture.gatewayClient.getImageCalls(), 0);
    assert.equal(fixture.gatewayClient.getEditCalls(), 0);
    assert.equal(fixture.runtime.getConversation(generationConversation.id).latestRun.status, "failed");
    assert.equal(fixture.runtime.getConversation(editingConversation.id).latestRun.status, "failed");
  } finally {
    fixture.close();
  }
}

test("restart recovery rejects image generation and editing without model replay", testImageRunsAreNotRestartRecovered);

/** 返回启动恢复结果的稳定原因码，供图片副作用拒绝断言复用。 */
function readRecoveryReason(outcome) {
  return outcome.reasonCode;
}

/** 验证 Responses 图片工具被上游拒绝时返回操作级配置建议，而不是泛化的短暂服务故障。 */
async function testImageEditingProviderFailureIsActionable() {
  const gatewayClient = createImageGateway();
  /** 模拟 LiteLLM 已接收请求、但上游图片工具权限或协议不兼容而返回 502。 */
  gatewayClient.editImages = async function rejectImageEditing() {
    throw new GatewayRequestError("Responses image editing failed", 502, {
      error: "Responses image editing failed",
      code: "image_edit_provider_error",
      providerCode: "access_denied",
    });
  };
  const fixture = createImageRuntimeFixture({ gatewayClient });
  try {
    const conversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(conversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    await assert.rejects(
      fixture.runtime.runConversation(conversation.id, {
        operation: "image.edit",
        requestId: "image-edit-provider-failure-request",
        clientMessageId: "image-edit-provider-failure-message",
        message: "保留主体并调亮背景",
        references: [{ type: "image_asset", assetId: source.assetId }],
      }),
      /** 只接受脱敏后的图片编辑上游分类和可执行配置提示。 */
      function matchesActionableImageEditFailure(error) {
        return error?.payload?.code === "image_edit_provider_unavailable" &&
          error.payload.operation === "image.edit" &&
          error.payload.action.includes("image_generation(action=edit)") &&
          !JSON.stringify(error.payload).includes("access_denied");
      },
    );
    const detail = fixture.runtime.getConversation(conversation.id);
    assert.equal(detail.latestRun.status, "failed");
    assert.equal(detail.latestRun.error, "图片编辑上游不可用");
    assert.equal(detail.messages.length, 1);
    assert.ok(fixture.store.getRunLease(detail.latestRun.id).releasedAt);
  } finally {
    fixture.close();
  }
}

test("image editing maps provider rejection to actionable safe feedback", testImageEditingProviderFailureIsActionable);

/** 验证 auto 单图低风险回退仍把同一受控资产临时交给视觉对话，且不持久化 Base64。 */
async function testAutoRoutesControlledImageToVisionChat() {
  let generatedMessages = null;
  const gatewayClient = createImageGateway();
  /** 允许 Runtime 按 vision 硬约束解析默认对话别名。 */
  gatewayClient.resolveConversationModel = async function resolveConversationModel() {
    return this.model;
  };
  /** 捕获业务视觉消息，证明受控资产只在本轮模型请求内转换为 data URL。 */
  gatewayClient.chatCompletions = async function chatCompletions({ messages }) {
    generatedMessages = messages;
    return { model: this.model, usage: null, choices: [{ message: { content: "这是一张测试图片" } }] };
  };
  const intentRouter = {
    /** 将看图问题解析为普通对话。 */
    async resolve() {
      return {
        operation: "conversation.chat",
        confidence: 0.96,
        source: "structured-classifier",
        candidates: ["conversation.chat", "image.edit"],
      };
    },
  };
  const fixture = createImageRuntimeFixture({ gatewayClient, intentRouter });
  try {
    const conversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(conversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    const result = await fixture.runtime.runConversation(conversation.id, {
      operation: "auto",
      requestId: "auto-image-chat-request",
      clientMessageId: "auto-image-chat-message",
      message: "这张图里有什么？",
      references: [{ type: "image_asset", assetId: source.assetId }],
    });
    const detail = fixture.runtime.getConversation(conversation.id);
    const currentMessage = generatedMessages.at(-1);

    assert.equal(result.operation, "conversation.chat");
    assert.equal(currentMessage.role, "user");
    assert.ok(currentMessage.content.some(isPngDataUrlPart));
    assert.equal(JSON.stringify(detail).includes("data:image/png;base64"), false);
    assert.equal(detail.latestRun.operation, "conversation.chat");
    assert.deepEqual(detail.messages[0].references, [{ type: "image_asset", assetId: source.assetId }]);
    assert.equal(fixture.gatewayClient.getEditCalls(), 0);
  } finally {
    fixture.close();
  }
}

test("auto vision fallback uses controlled image bytes without persisting Base64", testAutoRoutesControlledImageToVisionChat);

/** 判断 AI SDK 前的 OpenAI-compatible 当前消息 part 是否包含 PNG data URL。 */
function isPngDataUrlPart(part) {
  return part?.type === "image_url" && String(part.image_url?.url || "").startsWith("data:image/png;base64,");
}

/** 验证受控源文件被替换后在图片模型调用前以稳定完整性错误拒绝。 */
async function testImageEditingRejectsTamperedSourceBytes() {
  const fixture = createImageRuntimeFixture();
  try {
    const conversation = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(conversation.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    const stored = fixture.store.readImageAsset(conversation.id, source.assetId);
    writeFileSync(join(fixture.assetDirectory, stored.storageKey), createVersionedPngFixture(9));

    await assert.rejects(
      fixture.runtime.runConversation(conversation.id, {
        operation: "image.edit",
        requestId: "tampered-image-edit-request",
        clientMessageId: "tampered-image-edit-message",
        message: "把背景改成蓝色",
        references: [{ type: "image_asset", assetId: source.assetId }],
      }),
      /** 只接受不泄漏物理路径的资产完整性错误。 */
      function matchesImageIntegrityFailure(error) {
        return error?.payload?.code === "image_asset_integrity_mismatch" &&
          !JSON.stringify(error.payload).includes(stored.storageKey);
      },
    );
    assert.equal(fixture.gatewayClient.getEditCalls(), 0);
    assert.equal(fixture.runtime.getConversation(conversation.id).latestRun.status, "failed");
  } finally {
    fixture.close();
  }
}

test("image editing rejects source bytes that no longer match immutable metadata", testImageEditingRejectsTamperedSourceBytes);

/** 验证跨会话源资产在创建 Run 和调用图片模型前被统一拒绝。 */
async function testImageEditingRejectsForeignAsset() {
  const fixture = createImageRuntimeFixture();
  try {
    const owner = fixture.runtime.createConversation();
    const other = fixture.runtime.createConversation();
    const source = await fixture.runtime.uploadImageAsset(owner.id, {
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });

    await assert.rejects(
      fixture.runtime.runConversation(other.id, {
        operation: "image.edit",
        requestId: "foreign-image-edit-request",
        clientMessageId: "foreign-image-edit-message",
        message: "修改其他会话图片",
        references: [{ type: "image_asset", assetId: source.assetId }],
      }),
      /** 资产缺失与越权统一使用不泄漏来源会话的 404 分类。 */
      function matchesHiddenForeignAsset(error) {
        return error?.code === "image_asset_not_found" && error?.status === 404;
      },
    );

    assert.equal(fixture.gatewayClient.getEditCalls(), 0);
    assert.equal(fixture.runtime.getConversation(other.id).messages.length, 0);
  } finally {
    fixture.close();
  }
}

test("image editing rejects a foreign source asset before creating a run", testImageEditingRejectsForeignAsset);

/** 验证上传入口按真实文件签名拒绝伪造 MIME，且不会登记可用资产。 */
async function testImageUploadRejectsMediaMismatch() {
  const fixture = createImageRuntimeFixture();
  try {
    const conversation = fixture.runtime.createConversation();
    await assert.rejects(
      fixture.runtime.uploadImageAsset(conversation.id, {
        bytes: PNG_BYTES,
        mediaType: "image/jpeg",
      }),
      /** 只接受稳定的上传媒体不一致错误。 */
      function matchesUploadMediaMismatch(error) {
        return error?.payload?.code === "uploaded_image_media_mismatch";
      },
    );
    assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 0);
  } finally {
    fixture.close();
  }
}

test("image upload rejects a declared MIME mismatch", testImageUploadRejectsMediaMismatch);

/** 验证 PNG、JPEG 和 WebP 只有尺寸头但文件尾或 RIFF 内容截断时均被上传边界拒绝。 */
async function testImageUploadRejectsTruncatedFiles() {
  const fixture = createImageRuntimeFixture();
  const cases = [
    { bytes: TRUNCATED_PNG_BYTES, mediaType: "image/png" },
    { bytes: TRUNCATED_JPEG_BYTES, mediaType: "image/jpeg" },
    { bytes: TRUNCATED_WEBP_BYTES, mediaType: "image/webp" },
  ];
  try {
    const conversation = fixture.runtime.createConversation();
    for (const input of cases) {
      await assert.rejects(
        fixture.runtime.uploadImageAsset(conversation.id, input),
        matchesInvalidUploadedImage,
      );
    }
    assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 0);
  } finally {
    fixture.close();
  }
}

test("image upload rejects truncated PNG, JPEG, and WebP files", testImageUploadRejectsTruncatedFiles);

/** 验证结构边界完整但没有实际像素码流的 PNG 与 WebP 不会成为可用资产。 */
async function testImageUploadRejectsMetadataOnlyFiles() {
  const fixture = createImageRuntimeFixture();
  const cases = [
    { bytes: EMPTY_IDAT_PNG_BYTES, mediaType: "image/png" },
    { bytes: VP8X_ONLY_WEBP_BYTES, mediaType: "image/webp" },
  ];
  try {
    const conversation = fixture.runtime.createConversation();
    for (const input of cases) {
      await assert.rejects(
        fixture.runtime.uploadImageAsset(conversation.id, input),
        matchesInvalidUploadedImage,
      );
    }
    assert.equal(fixture.runtime.getConversation(conversation.id).messages.length, 0);
  } finally {
    fixture.close();
  }
}

test("image upload rejects empty PNG IDAT and VP8X-only WebP files", testImageUploadRejectsMetadataOnlyFiles);

/** 只接受上传完整性策略的稳定公开错误，不依赖解析器内部细节。 */
function matchesInvalidUploadedImage(error) {
  return error?.payload?.code === "invalid_uploaded_image" && error?.status === 400;
}

/** 验证 SQLite 元数据登记异常被脱敏，并清理已经写入的图片二进制。 */
async function testImageUploadMetadataFailureIsSanitized() {
  const deletedStorageKeys = [];
  const imageAssetStore = {
    /** 模拟二进制已经成功写入资产存储。 */
    async write({ assetId }) {
      return { storageKey: `${assetId}.png` };
    },
    /** 记录 Runtime 在元数据失败后的补偿清理。 */
    async delete(storageKey) {
      deletedStorageKeys.push(storageKey);
    },
  };
  const fixture = createImageRuntimeFixture({ imageAssetStore });
  try {
    const conversation = fixture.runtime.createConversation();
    /** 模拟包含内部表名的 SQLite 原始登记异常。 */
    function failImageAssetRegistration() {
      throw new Error("SQLITE_CONSTRAINT image_assets.storage_key internal-only");
    }
    fixture.store.createImageAsset = failImageAssetRegistration;

    let failure = null;
    try {
      await fixture.runtime.uploadImageAsset(conversation.id, {
        bytes: PNG_BYTES,
        mediaType: "image/png",
      });
    } catch (error) {
      failure = error;
    }

    assert.equal(failure?.status, 500);
    assert.equal(failure?.payload?.code, "image_asset_metadata_write_failed");
    assert.equal(failure?.message, "图片上传登记失败");
    assert.equal(JSON.stringify(failure?.payload).includes("SQLITE_CONSTRAINT"), false);
    assert.equal(deletedStorageKeys.length, 1);
  } finally {
    fixture.close();
  }
}

test("image upload sanitizes metadata failures and removes uncommitted bytes", testImageUploadMetadataFailureIsSanitized);

/** 验证新建 SQLite 的工具调用必须属于 Run，而上传图片可以先于 Run 创建。 */
function testFreshImageSchemaRunOwnership() {
  const directory = mkdtempSync(join(tmpdir(), "ai-platform-image-schema-"));
  const databasePath = join(directory, "conversation.sqlite");
  try {
    const store = createConversationStore({ databasePath });
    store.close();
    const database = new DatabaseSync(databasePath);
    const toolRunId = database.prepare("PRAGMA table_info(tool_calls)").all().find(isRunIdColumn);
    const imageRunId = database.prepare("PRAGMA table_info(image_assets)").all().find(isRunIdColumn);
    assert.equal(Number(toolRunId.notnull), 1);
    assert.equal(Number(imageRunId.notnull), 0);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("fresh schema keeps tool run ownership required and upload run ownership optional", testFreshImageSchemaRunOwnership);

/** 验证旧版非空 run_id 资产表升级后保留生成产物，并允许登记上传资产。 */
function testImageAssetRunOwnershipMigration() {
  const directory = mkdtempSync(join(tmpdir(), "ai-platform-image-asset-migration-"));
  const databasePath = join(directory, "conversation.sqlite");
  try {
    const originalStore = createConversationStore({ databasePath });
    const conversation = originalStore.createConversation();
    const started = originalStore.startRun({
      conversationId: conversation.id,
      requestId: "legacy-image-request",
      clientMessageId: "legacy-image-message",
      content: "生成旧图片",
      displayContent: "生成旧图片",
      operation: "image.generate",
    });
    originalStore.completeImageRun({
      runId: started.run.id,
      assets: [{
        assetId: "11111111-1111-4111-8111-111111111111",
        storageKey: "11111111-1111-4111-8111-111111111111.png",
        mediaType: "image/png",
        sizeBytes: PNG_BYTES.length,
        width: 1,
        height: 1,
        sha256: "legacy-sha256",
      }],
      displayContent: "已生成 1 张图片",
      usage: null,
      model: "image-default",
      resilience: null,
    });
    originalStore.close();

    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE image_assets_legacy (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('available', 'blocked', 'expired')),
        storage_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      INSERT INTO image_assets_legacy SELECT * FROM image_assets;
      CREATE TABLE message_artifacts_legacy (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES image_assets_legacy(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY(message_id, asset_id),
        UNIQUE(message_id, position)
      );
      INSERT INTO message_artifacts_legacy SELECT * FROM message_artifacts;
      DROP TABLE message_artifacts;
      DROP TABLE image_assets;
      ALTER TABLE image_assets_legacy RENAME TO image_assets;
      ALTER TABLE message_artifacts_legacy RENAME TO message_artifacts;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    legacyDatabase.close();

    const migratedStore = createConversationStore({ databasePath });
    const detail = migratedStore.getConversation(conversation.id);
    const uploaded = migratedStore.createImageAsset({
      conversationId: conversation.id,
      asset: {
        assetId: "22222222-2222-4222-8222-222222222222",
        storageKey: "22222222-2222-4222-8222-222222222222.png",
        mediaType: "image/png",
        sizeBytes: PNG_BYTES.length,
        width: 1,
        height: 1,
        sha256: "uploaded-sha256",
      },
    });
    assert.equal(detail.messages.at(-1).artifacts[0].source, "generated");
    assert.equal(uploaded.runId, null);
    migratedStore.close();

    const verifiedDatabase = new DatabaseSync(databasePath);
    const runIdColumn = verifiedDatabase.prepare("PRAGMA table_info(image_assets)").all().find(isRunIdColumn);
    assert.equal(Number(runIdColumn.notnull), 0);
    assert.deepEqual(verifiedDatabase.prepare("PRAGMA foreign_key_check").all(), []);
    verifiedDatabase.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("image asset migration preserves generated artifacts and enables uploads", testImageAssetRunOwnershipMigration);

/** 判断 SQLite 表信息是否为图片资产 run_id 列。 */
function isRunIdColumn(column) {
  return column.name === "run_id";
}

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
    function recordRunStarted(event) {
      if (event.type === "run.started") runId = event.runId;
    }
    const resultPromise = fixture.runtime.runConversation(conversation.id, {
      operation: "image.generate",
      requestId: "image-cancel-request",
      clientMessageId: "image-cancel-message",
      message: "生成一张等待取消的图片",
    }, { eventSink: createRunEventSink({ subscribers: [recordRunStarted] }) });
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
    assert.ok(fixture.store.getRunLease(detail.latestRun.id).releasedAt);
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
  /** 让图片别名通过 GatewayClient 的目录授权后再进入受控超时场景。 */
  function returnImageModelDirectory() {
    return new Response(JSON.stringify({ data: [{ id: "chat-default" }, { id: "image-default" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const gatewayClient = createGatewayClient(
    {
      baseUrl: "http://gateway.test",
      model: "chat-default",
      imageModel: "image-default",
      apiKey: "test-key",
      fetchImplementation: returnImageModelDirectory,
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
  intentRouter,
  executionPolicy,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ai-platform-image-generation-"));
  const assetDirectory = join(directory, "assets");
  const store = createConversationStore({ databasePath: join(directory, "conversation.sqlite") });
  const imageAssetStore = providedAssetStore || createLocalImageAssetStore({ directory: assetDirectory });
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
    intentRouter,
    executionPolicy,
  });
  return {
    store,
    assetDirectory,
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
  // Promise executor 暴露模型调用开始信号，供取消测试等待确定阶段。
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
  // Promise executor 把一次 AbortSignal 事件桥接为测试等待结果。
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
  let editCalls = 0;
  const editSources = [];
  const editResults = [];
  const editPrompts = [];
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
    /** 返回固定编辑结果，并保存 Runtime 传入的受控源图片字节。 */
    async editImages({ model, prompt, size, sourceImages }) {
      editCalls += 1;
      assert.equal(size, "1024x1024");
      assert.equal(sourceImages.length, 1);
      editSources.push(Buffer.from(sourceImages[0].bytes));
      editPrompts.push(String(prompt || ""));
      const resultBytes = createVersionedPngFixture(editCalls);
      editResults.push(resultBytes);
      return {
        model,
        images: [{ bytes: resultBytes, mediaType: "image/png" }],
        usage: { input_tokens: null, output_tokens: null, total_tokens: null, generated_images: 1 },
        resilience: {
          operation: "model.image.edit",
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
    /** 返回真实图片编辑调用次数，供幂等和权限断言。 */
    getEditCalls() {
      return editCalls;
    },
    /** 返回每次编辑收到的源图副本，供多轮来源断言。 */
    getEditSources() {
      const copies = [];
      for (const bytes of editSources) copies.push(Buffer.from(bytes));
      return copies;
    },
    /** 返回每次编辑产生的图片副本，供资产不可变断言。 */
    getEditResults() {
      const copies = [];
      for (const bytes of editResults) copies.push(Buffer.from(bytes));
      return copies;
    },
    /** 返回每次图片编辑实际收到的 Prompt，供上下文证据组装断言。 */
    getEditPrompts() {
      return [...editPrompts];
    },
  };
}

/** 创建结构边界完整且每轮字节不同的 PNG fixture。 */
function createVersionedPngFixture(version) {
  const bytes = Buffer.from(PNG_BYTES);
  const imageDataTypeOffset = bytes.indexOf("IDAT", 0, "ascii");
  bytes[imageDataTypeOffset + 4] ^= Number(version) & 0xff;
  return bytes;
}

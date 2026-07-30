import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Actions,
  Attachments,
  Bubble,
  Conversations,
  Prompts,
  Sender,
  Welcome,
} from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import {
  Alert,
  Button,
  Drawer,
  Dropdown,
  Empty,
  Image,
  Input,
  Modal,
  Progress,
  Select,
  Tag,
  Tooltip,
  Typography,
  message as toast,
} from "antd";
import {
  Archive,
  ArrowDown,
  Bot,
  Brain,
  CircleAlert,
  Copy,
  Database,
  Ellipsis,
  FileImage,
  FileText,
  Gauge,
  Link2,
  LoaderCircle,
  Menu,
  MessageSquareQuote,
  PanelRight,
  Paperclip,
  Plus,
  Quote,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  activeRunStageLabel,
  buildGatewayReachabilityCopy,
  buildMessagePreview,
  buildRunFailureCopy,
  canSubmitRun,
  conversationStatusLabel,
  insertLatestRunFailure,
  isMessageListAtLatest,
  readGatewayModels,
  readConversationDraft,
  recoverRunInput,
  scrollMessageListToLatest as scrollReadyMessageListToLatest,
  storeConversationDraft,
} from "./conversation-view-model.js";
import ConversationAnchorRail from "./conversation-anchor-rail.jsx";
import { runtimeAdapter } from "./runtime-adapter.js";

const { Text, Title } = Typography;
const MAX_ATTACHMENTS = 8;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCES = 3;

let workspaceInitializationPromise = null;

/** 只执行一次初始事实读取，避免 React StrictMode 在开发模式重复创建空会话。 */
function initializeWorkspace() {
  if (!workspaceInitializationPromise) workspaceInitializationPromise = loadInitialWorkspace();
  return workspaceInitializationPromise;
}

/** 同时读取网关与会话事实；没有会话时创建唯一初始会话。 */
async function loadInitialWorkspace() {
  const [gateway, initialConversations] = await Promise.all([
    loadGatewayStatusSafely(),
    runtimeAdapter.listConversations(),
  ]);
  const conversations = [...initialConversations];
  if (conversations.length === 0) conversations.push(await runtimeAdapter.createConversation());
  const conversation = await runtimeAdapter.getConversation(conversations[0].id);
  return { gateway, conversations, conversation };
}

/** 网关不可用时保留渠道页面与本地会话能力，并返回可展示的失败状态。 */
async function loadGatewayStatusSafely() {
  try {
    return await runtimeAdapter.getGatewayStatus();
  } catch (error) {
    return { ok: false, error: error.message, model: "-", models: [], gatewayBaseUrl: "-" };
  }
}

/** AI 应用基础平台 C1 渠道工作台。 */
export default function App() {
  const [toastApi, toastContext] = toast.useMessage();
  const [gateway, setGateway] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [composerValue, setComposerValue] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [references, setReferences] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [gatewayChecking, setGatewayChecking] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [runError, setRunError] = useState("");
  const [lastLatency, setLastLatency] = useState(null);
  const [conversationDrawerOpen, setConversationDrawerOpen] = useState(false);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [unseenMessageCount, setUnseenMessageCount] = useState(0);
  const [linkDraft, setLinkDraft] = useState({ open: false, type: "document", value: "", error: "" });
  const attachmentComponentRef = useRef(null);
  const messageListRef = useRef(null);
  const composerValueRef = useRef("");
  const attachmentFactsRef = useRef([]);
  const referenceFactsRef = useRef([]);
  const selectedModelRef = useRef("");
  const conversationDraftsRef = useRef(new Map());
  const visibleMessageCountRef = useRef({ conversationId: null, count: 0 });
  const activeRunRef = useRef(null);
  const cancelRequestedRef = useRef(false);

  // 首次挂载时复用唯一初始化 Promise，并忽略卸载后的异步结果。
  useEffect(() => {
    let disposed = false;
    /** 把初始网关、会话列表和当前事实装入页面状态。 */
    async function applyInitialWorkspace() {
      try {
        const data = await initializeWorkspace();
        if (disposed) return;
        setGateway(data.gateway);
        setSelectedModelFact(resolveSelectedModel(data.gateway));
        setConversations(data.conversations);
        setCurrentConversationId(data.conversation.id);
        setConversation(data.conversation);
      } catch (error) {
        if (!disposed) setRunError(error.message);
      } finally {
        if (!disposed) setInitializing(false);
      }
    }
    void applyInitialWorkspace();
    /** 标记本次 effect 已卸载，避免延迟网络结果写入旧组件。 */
    return function disposeInitialization() {
      disposed = true;
    };
  }, []);

  // 当前会话变化时重建事实 SSE，并合并短时间内的事件刷新。
  useEffect(() => {
    if (!currentConversationId) return undefined;
    let refreshTimer = null;
    let disposed = false;

    /** 从 SQLite API 同步当前会话与会话列表。 */
    async function refreshFromFactEvent() {
      if (disposed || activeRunRef.current?.conversationId === currentConversationId) return;
      try {
        const [detail, items] = await Promise.all([
          runtimeAdapter.getConversation(currentConversationId),
          runtimeAdapter.listConversations(),
        ]);
        if (!disposed) {
          setConversation(detail);
          setConversations(items);
        }
      } catch (error) {
        if (!disposed) setRunError(error.message);
      }
    }

    /** 合并相邻事实事件，避免一轮 Run 的多条日志触发重复详情请求。 */
    function scheduleFactRefresh() {
      if (activeRunRef.current?.conversationId === currentConversationId) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshFromFactEvent, 120);
    }

    /** EventSource 会自动重连，页面只在载荷解析错误时给出非阻断提示。 */
    function handleFactStreamError(error) {
      if (error instanceof SyntaxError) setRunError("会话事实事件格式无效");
    }

    const subscription = runtimeAdapter.subscribeConversation(currentConversationId, {
      onEvent: scheduleFactRefresh,
      onError: handleFactStreamError,
    });
    /** 关闭旧会话订阅和未执行的合并刷新。 */
    return function disposeSubscription() {
      disposed = true;
      clearTimeout(refreshTimer);
      subscription.close();
    };
  }, [currentConversationId]);

  /** 同步 React 与 ref 中的 Sender 正文，供异步会话切换读取最新草稿。 */
  function setComposerFact(next) {
    const normalized = String(next || "");
    composerValueRef.current = normalized;
    setComposerValue(normalized);
  }

  /** 同步 React 与 ref 中的附件事实，供并发 FileReader 回调稳定追加。 */
  function setAttachmentFacts(next) {
    attachmentFactsRef.current = next;
    setAttachments(next);
  }

  /** 同步 React 与 ref 中的引用事实，保证发送载荷只取当前队列。 */
  function setReferenceFacts(next) {
    referenceFactsRef.current = next;
    setReferences(next);
  }

  /** 同步 React 与 ref 中的当前模型别名，保证异步发送读取的是已确认选择。 */
  function setSelectedModelFact(next) {
    const normalized = String(next || "").trim();
    selectedModelRef.current = normalized;
    setSelectedModel(normalized);
  }

  /** 在网关可见别名中保留当前选择，不可用时回退默认或第一个别名。 */
  function resolveSelectedModel(nextGateway, requestedModel = selectedModelRef.current) {
    const models = readGatewayModels(nextGateway);
    const requested = String(requestedModel || "").trim();
    if (models.includes(requested)) return requested;
    const defaultModel = String(nextGateway?.model || "").trim();
    return models.includes(defaultModel) ? defaultModel : models[0] || "";
  }

  /** 保存当前会话尚未发送的渠道草稿；空草稿会清理旧快照。 */
  function saveCurrentConversationDraft() {
    conversationDraftsRef.current = storeConversationDraft(
      conversationDraftsRef.current,
      currentConversationId,
      {
        value: composerValueRef.current,
        attachments: attachmentFactsRef.current,
        references: referenceFactsRef.current,
        model: selectedModelRef.current,
      },
    );
  }

  /** 恢复目标会话的独立渠道草稿，不把其他会话输入带入当前 Sender。 */
  function restoreConversationDraft(conversationId) {
    const draft = readConversationDraft(conversationDraftsRef.current, conversationId);
    setComposerFact(draft.value);
    setAttachmentFacts(draft.attachments);
    setReferenceFacts(draft.references);
    setSelectedModelFact(resolveSelectedModel(gateway, draft.model));
  }

  /** 删除指定会话已经发送或主动结束的渠道草稿。 */
  function clearConversationDraft(conversationId) {
    conversationDraftsRef.current = storeConversationDraft(
      conversationDraftsRef.current,
      conversationId,
      { value: "", attachments: [], references: [], model: selectedModelRef.current },
    );
  }

  /** 同步 React 与 ref 中的活动 Run，供事实 SSE effect 读取最新生成状态。 */
  function setActiveRunFact(next) {
    activeRunRef.current = next;
    setActiveRun(next);
  }

  /** 在当前活动 Run 上合并局部状态，Run 已收口时忽略迟到增量。 */
  function patchActiveRun(patch) {
    const current = activeRunRef.current;
    if (!current) return;
    setActiveRunFact({ ...current, ...patch });
  }

  /** 重新检查模型网关，并按用户主动触发与后台刷新区分提示。 */
  async function refreshGatewayStatus({ announce = false } = {}) {
    setGatewayChecking(true);
    const next = await loadGatewayStatusSafely();
    setGateway(next);
    setSelectedModelFact(resolveSelectedModel(next));
    setGatewayChecking(false);
    if (announce) {
      const copy = buildGatewayReachabilityCopy(next);
      if (next.ok) toastApi.success(copy.announcement);
      else toastApi.warning(copy.announcement);
    }
    return next;
  }

  /** 响应用户的网关重新检测命令。 */
  function handleRefreshGateway() {
    void refreshGatewayStatus({ announce: true });
  }

  /** 选择会话并读取服务端完整事实；生成期间保持当前 Run 视图稳定。 */
  async function handleConversationChange(conversationId) {
    if (activeRunRef.current || conversationId === currentConversationId) return;
    saveCurrentConversationDraft();
    setCurrentConversationId(conversationId);
    setConversation(null);
    setRunError("");
    restoreConversationDraft(conversationId);
    setIsFollowingLatest(true);
    setUnseenMessageCount(0);
    setConversationDrawerOpen(false);
    try {
      setConversation(await runtimeAdapter.getConversation(conversationId));
    } catch (error) {
      setRunError(error.message);
    }
  }

  /** 创建新的服务端会话并立即切换，不在浏览器生成虚拟会话事实。 */
  async function handleCreateConversation() {
    if (activeRunRef.current) return;
    saveCurrentConversationDraft();
    try {
      const created = await runtimeAdapter.createConversation();
      const items = await runtimeAdapter.listConversations();
      setConversations(items);
      setCurrentConversationId(created.id);
      setConversation(created);
      restoreConversationDraft(created.id);
      setIsFollowingLatest(true);
      setUnseenMessageCount(0);
      setConversationDrawerOpen(false);
    } catch (error) {
      setRunError(error.message);
    }
  }

  /** 请求 Runtime 完成 checkpoint 并关闭当前会话。 */
  async function closeCurrentConversation() {
    try {
      const result = await runtimeAdapter.closeConversation(currentConversationId);
      const [detail, items] = await Promise.all([
        runtimeAdapter.getConversation(result.conversation.id),
        runtimeAdapter.listConversations(),
      ]);
      setConversation(detail);
      setConversations(items);
      clearConversationDraft(currentConversationId);
      setComposerFact("");
      setAttachmentFacts([]);
      setReferenceFacts([]);
      toastApi.success("会话已结束");
    } catch (error) {
      setRunError(error.message);
    }
  }

  /** 打开关闭确认，避免误触造成会话永久拒绝新 Run。 */
  function handleCloseConversation() {
    if (!conversation || conversation.status !== "active" || activeRunRef.current) return;
    Modal.confirm({
      title: "结束当前会话？",
      content: "结束后将完成最终记忆 checkpoint，已持久化消息会保留。",
      okText: "结束会话",
      cancelText: "取消",
      onOk: closeCurrentConversation,
    });
  }

  /** 更新受控 Sender 文本。 */
  function handleComposerChange(value) {
    setComposerFact(value);
  }

  /** 更新当前会话 Sender 使用的模型别名，活动 Run 期间保持选择不可变。 */
  function handleModelChange(value) {
    if (activeRunRef.current) return;
    setSelectedModelFact(value);
  }

  /** 将选中的建议填入 Sender，仍由用户决定是否发送。 */
  function handlePromptClick({ data }) {
    setComposerFact(data.label);
  }

  /** 将一条已持久化消息加入当前发送引用队列，最多保留三条。 */
  function handleQuoteMessage(message) {
    if (
      !message?.id ||
      String(message.id).startsWith("optimistic:") ||
      String(message.id).startsWith("streaming:")
    ) return;
    for (const reference of referenceFactsRef.current) {
      if (reference.messageId === message.id) return;
    }
    if (referenceFactsRef.current.length >= MAX_REFERENCES) {
      toastApi.warning(`最多引用 ${MAX_REFERENCES} 条消息`);
      return;
    }
    setReferenceFacts([
      ...referenceFactsRef.current,
      {
        type: "conversation_message",
        messageId: message.id,
        role: message.role,
        preview: buildMessagePreview(message.displayContent),
      },
    ]);
  }

  /** 按稳定 messageId 从当前发送引用队列移除一项。 */
  function handleRemoveReference(messageId) {
    const next = [];
    for (const reference of referenceFactsRef.current) {
      if (reference.messageId !== messageId) next.push(reference);
    }
    setReferenceFacts(next);
  }

  /** 用服务端消息事实恢复失败 Run 的正文、附件和引用，生成新 Run 时再创建新幂等标识。 */
  function restoreFailedInput(sourceMessageId) {
    const sourceMessage = conversation?.messages?.find(
      // 恢复只认稳定 messageId，不能从失败提示里的展示文本反推输入。
      (message) => message.id === sourceMessageId,
    );
    if (!sourceMessage) {
      toastApi.error("未找到失败 Run 对应的用户消息");
      return;
    }
    const recovered = recoverRunInput(sourceMessage);
    const recoveredAttachments = buildRecoveredAttachments(recovered.imageUrls, recovered.documentUrls);
    const recoveredReferences = buildRecoveredReferences(recovered.references, conversation.messages);
    setComposerFact(recovered.message);
    setAttachmentFacts(recoveredAttachments);
    setReferenceFacts(recoveredReferences);
    setRunError("");
    toastApi.success("原输入已恢复，可调整后重新发送");
  }

  /** 恢复失败输入前保护当前草稿，避免覆盖用户尚未发送的内容。 */
  function handleRestoreFailedInput(sourceMessageId) {
    const hasDraft = Boolean(composerValue.trim() || attachments.length > 0 || references.length > 0);
    if (!hasDraft) {
      restoreFailedInput(sourceMessageId);
      return;
    }
    Modal.confirm({
      title: "覆盖当前草稿？",
      content: "恢复失败 Run 的输入会替换当前正文、附件和引用。",
      okText: "恢复输入",
      cancelText: "保留草稿",
      /** 用户确认后才覆盖当前渠道草稿。 */
      onOk() {
        restoreFailedInput(sourceMessageId);
      },
    });
  }

  /** 触发 Ant Design X Attachments 的隐藏图片选择器。 */
  function openImagePicker() {
    attachmentComponentRef.current?.select({ accept: "image/*", multiple: true });
  }

  /** 根据附件菜单动作打开图片选择器或 URL 输入框。 */
  function handleAttachmentMenuClick({ key }) {
    if (key === "upload-image") {
      openImagePicker();
      return;
    }
    setLinkDraft({ open: true, type: key === "image-url" ? "image" : "document", value: "", error: "" });
  }

  /** 校验本地图片并转换为 Runtime 已支持的 data URL。 */
  async function handleBeforeUpload(file) {
    if (!file.type.startsWith("image/")) {
      toastApi.error("只能上传图片文件");
      return false;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toastApi.error("单张图片不能超过 5 MB");
      return false;
    }
    if (countImageAttachments(attachmentFactsRef.current) >= MAX_IMAGES) {
      toastApi.warning(`最多添加 ${MAX_IMAGES} 张图片`);
      return false;
    }
    if (attachmentFactsRef.current.length >= MAX_ATTACHMENTS) {
      toastApi.warning(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
      return false;
    }
    const url = await readFileAsDataUrl(file);
    setAttachmentFacts([
      ...attachmentFactsRef.current,
      {
        uid: crypto.randomUUID(),
        name: file.name,
        status: "done",
        type: file.type,
        size: file.size,
        url,
        thumbUrl: url,
        cardType: "image",
        kind: "image",
      },
    ]);
    return false;
  }

  /** 将粘贴的图片逐个交给同一附件校验流程。 */
  function handlePasteFiles(files) {
    for (const file of files) void handleBeforeUpload(file);
  }

  /** 按 Attachments 的 uid 移除受控附件。 */
  function handleRemoveAttachment(item) {
    const next = [];
    for (const attachment of attachmentFactsRef.current) {
      if (attachment.uid !== item.uid) next.push(attachment);
    }
    setAttachmentFacts(next);
    return true;
  }

  /** 更新 URL 附件输入值并清除旧校验错误。 */
  function handleLinkDraftChange(event) {
    setLinkDraft({ ...linkDraft, value: event.target.value, error: "" });
  }

  /** 关闭 URL 附件输入框并清空暂存值。 */
  function closeLinkDraft() {
    setLinkDraft({ open: false, type: "document", value: "", error: "" });
  }

  /** 校验并添加 http(s) 图片或文档链接附件。 */
  function confirmLinkDraft() {
    const url = linkDraft.value.trim();
    if (!isHttpUrl(url)) {
      setLinkDraft({ ...linkDraft, error: "请输入有效的 http(s) URL" });
      return;
    }
    if (attachmentFactsRef.current.length >= MAX_ATTACHMENTS) {
      setLinkDraft({ ...linkDraft, error: `最多添加 ${MAX_ATTACHMENTS} 个附件` });
      return;
    }
    if (linkDraft.type === "image" && countImageAttachments(attachmentFactsRef.current) >= MAX_IMAGES) {
      setLinkDraft({ ...linkDraft, error: `最多添加 ${MAX_IMAGES} 张图片` });
      return;
    }
    setAttachmentFacts([
      ...attachmentFactsRef.current,
      {
        uid: crypto.randomUUID(),
        name: readableUrlName(url),
        status: "done",
        url,
        thumbUrl: linkDraft.type === "image" ? url : undefined,
        cardType: linkDraft.type === "image" ? "image" : "file",
        kind: linkDraft.type,
        description: linkDraft.type === "image" ? "图片链接" : "文档链接",
      },
    ]);
    closeLinkDraft();
  }

  /** 调用显式取消端点；失败时保留 Run 视图并允许再次停止。 */
  async function cancelKnownRun(conversationId, runId) {
    try {
      await runtimeAdapter.cancelRun(conversationId, runId);
    } catch (error) {
      cancelRequestedRef.current = false;
      patchActiveRun({ status: "running" });
      setRunError(`停止生成失败：${error.message}`);
    }
  }

  /** 标记用户停止意图；尚无 runId 时等待 run-started 后立即取消。 */
  function handleCancelGeneration() {
    const run = activeRunRef.current;
    if (!run || cancelRequestedRef.current) return;
    cancelRequestedRef.current = true;
    patchActiveRun({ status: "stopping" });
    if (run.runId) void cancelKnownRun(run.conversationId, run.runId);
  }

  /** 提交当前文本、附件和稳定消息引用，并消费服务端 POST SSE。 */
  async function handleSubmit(value) {
    const current = conversation;
    if (!current || current.status !== "active" || activeRunRef.current) return;
    if (gateway?.ok !== true) {
      toastApi.warning("模型网关不可达，请重新检测后再发送");
      return;
    }
    if (!selectedModelRef.current) {
      toastApi.warning("当前没有可用模型，请重新检测模型网关");
      return;
    }
    const payload = buildRunPayload(
      value,
      attachmentFactsRef.current,
      referenceFactsRef.current,
      selectedModelRef.current,
    );
    if (!hasRunInput(payload)) return;

    const startedAt = performance.now();
    const optimisticUser = buildOptimisticUserMessage(current.id, payload);
    const runState = {
      conversationId: current.id,
      requestId: payload.requestId,
      runId: null,
      status: "starting",
      model: payload.model,
      partialText: "",
      optimisticUser,
    };
    cancelRequestedRef.current = false;
    setActiveRunFact(runState);
    setRunError("");
    clearConversationDraft(current.id);
    setComposerFact("");
    setAttachmentFacts([]);
    setReferenceFacts([]);

    /** 接收稳定 runId，并补偿 run-started 前已经点击的停止意图。 */
    function handleRunStarted(event) {
      patchActiveRun({ runId: event.runId, status: cancelRequestedRef.current ? "stopping" : "running" });
      if (cancelRequestedRef.current) void cancelKnownRun(current.id, event.runId);
    }

    /** 将模型增量追加到单个乐观助手消息。 */
    function handleTextDelta(delta) {
      const run = activeRunRef.current;
      if (!run || run.conversationId !== current.id) return;
      patchActiveRun({ partialText: `${run.partialText}${delta}`, status: "running" });
    }

    /** 把 SSE 取消终止阶段映射为 UI 中的停止状态，最终仍由详情事实覆盖。 */
    function handleCancelled() {
      patchActiveRun({ status: "cancelled" });
    }

    try {
      const terminal = await runtimeAdapter.runConversationStream(current.id, payload, {
        onRunStarted: handleRunStarted,
        onTextDelta: handleTextDelta,
        onCancelled: handleCancelled,
      });
      const [detail, items] = await Promise.all([
        runtimeAdapter.getConversation(current.id),
        runtimeAdapter.listConversations(),
      ]);
      if (currentConversationId === current.id) setConversation(detail);
      setConversations(items);
      setLastLatency(Math.round(performance.now() - startedAt));
      if (terminal.type === "cancelled") toastApi.info("已停止生成");
    } catch (error) {
      const failure = buildRunFailureCopy({
        status: "failed",
        statusCode: error.status,
        error: error.message,
        publicError: error.payload,
        model: payload.model,
      });
      void refreshGatewayStatus();
      let persistedFailure = false;
      try {
        const detail = await runtimeAdapter.getConversation(current.id);
        persistedFailure = detail.latestRun?.status === "failed" && detail.latestRun?.requestId === payload.requestId;
        if (currentConversationId === current.id) setConversation(detail);
      } catch {
        // 原始流错误已经足够诊断，恢复读取失败不覆盖它。
      }
      setRunError(persistedFailure ? "" : `${failure.title}：${error.payload?.detail || failure.detail}`);
    } finally {
      cancelRequestedRef.current = false;
      setActiveRunFact(null);
    }
  }

  /** 清除当前非持久化错误提示。 */
  function clearRunError() {
    setRunError("");
  }

  /** 打开移动端会话 Drawer。 */
  function openConversationDrawer() {
    setConversationDrawerOpen(true);
  }

  /** 关闭移动端会话 Drawer。 */
  function closeConversationDrawer() {
    setConversationDrawerOpen(false);
  }

  /** 打开移动端上下文 Drawer。 */
  function openContextDrawer() {
    setContextDrawerOpen(true);
  }

  /** 关闭移动端上下文 Drawer。 */
  function closeContextDrawer() {
    setContextDrawerOpen(false);
  }

  /** 在桌面端展开或收起运行上下文 Inspector。 */
  function toggleContextInspector() {
    setContextExpanded(!contextExpanded);
  }

  /** 从失败提示打开运行上下文；窄屏使用 Drawer，桌面使用 Inspector。 */
  function openRunContext() {
    if (globalThis.matchMedia?.("(max-width: 900px)").matches) {
      setContextDrawerOpen(true);
      return;
    }
    setContextExpanded(true);
  }

  /** 通过 Bubble.List 公开接口回到视觉底部，并恢复后续内容跟随。 */
  function scrollMessageListToLatest(behavior = "smooth") {
    scrollReadyMessageListToLatest(messageListRef.current, behavior);
  }

  /** 响应用户的“回到最新”命令。 */
  function handleReturnToLatest() {
    scrollMessageListToLatest();
  }

  /** 根据反向滚动列表的位置切换跟随状态，用户向上浏览时保留当前视窗。 */
  function handleMessageListScroll(event) {
    const followingLatest = isMessageListAtLatest(event.currentTarget.scrollTop);
    setIsFollowingLatest(followingLatest);
    if (followingLatest) setUnseenMessageCount(0);
  }

  /** 按稳定 messageId 定位并短暂高亮当前会话中的来源消息。 */
  function handleNavigateToMessage(messageId) {
    const element = document.getElementById(messageElementId(messageId));
    if (!element) {
      toastApi.warning("当前消息暂时不可定位");
      return;
    }
    element.classList.remove("is-reference-target");
    void element.offsetWidth;
    element.classList.add("is-reference-target");
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.focus({ preventScroll: true });
    /** 动画完成后移除状态，允许再次点击同一引用时重新播放。 */
    function clearReferenceHighlight() {
      element.classList.remove("is-reference-target");
    }
    element.addEventListener("animationend", clearReferenceHighlight, { once: true });
  }

  /** 复制消息正文并提供移动端可见反馈。 */
  async function handleCopyMessage(message) {
    try {
      await navigator.clipboard.writeText(message.displayContent || "");
      toastApi.success("已复制消息");
    } catch {
      toastApi.error("复制失败，请手动选择消息内容");
    }
  }

  const visibleMessages = useMemo(
    // 服务端消息是基线，活动 Run 只追加当前渠道的乐观用户与助手消息。
    () => buildVisibleMessages(conversation, activeRun, currentConversationId),
    [conversation, activeRun, currentConversationId],
  );

  // 用户主动发送新消息时回到底部；后续向上浏览仍由 onScroll 关闭跟随。
  useEffect(() => {
    if (!activeRun?.requestId) return;
    scrollMessageListToLatest("smooth");
  }, [activeRun?.requestId]);

  // 按会话统计离开底部后新增的消息条数，流式文本增长不会重复计数。
  useEffect(() => {
    const previous = visibleMessageCountRef.current;
    const nextCount = visibleMessages.length;
    if (previous.conversationId !== currentConversationId) {
      visibleMessageCountRef.current = { conversationId: currentConversationId, count: nextCount };
      setUnseenMessageCount(0);
      return;
    }
    const addedCount = Math.max(0, nextCount - previous.count);
    visibleMessageCountRef.current = { conversationId: currentConversationId, count: nextCount };
    if (isFollowingLatest) {
      setUnseenMessageCount(0);
      return;
    }
    if (addedCount > 0) {
      /** 合并同一次事实刷新中新增的消息，避免覆盖尚未查看的数量。 */
      function addUnseenMessages(currentCount) {
        return currentCount + addedCount;
      }
      setUnseenMessageCount(addUnseenMessages);
    }
  }, [currentConversationId, visibleMessages.length, isFollowingLatest]);

  const bubbleItems = useMemo(
    // Bubble 项只承载展示状态，messageId 和正文事实仍来自服务端消息。
    () => buildBubbleItems(visibleMessages, {
      onQuote: handleQuoteMessage,
      onCopy: handleCopyMessage,
      onNavigateReference: handleNavigateToMessage,
      onRestoreFailedInput: handleRestoreFailedInput,
      onOpenContext: openRunContext,
    }),
    [visibleMessages],
  );
  const canSubmit = canSubmitRun({
    conversationStatus: conversation?.status,
    gatewayOk: gateway?.ok,
    activeRun,
    hasInput: composerValue.trim() || attachments.length > 0 || references.length > 0,
  });
  const modelOptions = readGatewayModels(gateway).map(
    // Ant Design Select 只需要稳定别名，不暴露真实上游模型配置。
    (model) => ({ value: model, label: model }),
  );

  /** 使用 Sender 提供的原生发送按钮，同时允许附件或引用作为唯一输入。 */
  function renderSenderSuffix(originalNode, { components }) {
    if (activeRun) return originalNode;
    return <components.SendButton disabled={!canSubmit} />;
  }

  /** 在 Sender footer 中只渲染当前 Run 模型选择，发送动作继续由 suffix 唯一承载。 */
  function renderSenderFooter() {
    return (
      <div className="sender-footer">
        <div className="sender-model-select">
          <Text type="secondary">模型</Text>
          <Select
            size="small"
            value={selectedModel || undefined}
            options={modelOptions}
            disabled={Boolean(activeRun) || gateway?.ok !== true || modelOptions.length === 0}
            placeholder="无可用模型"
            aria-label="选择模型"
            onChange={handleModelChange}
          />
        </div>
      </div>
    );
  }

  const attachmentMenu = {
    items: [
      { key: "upload-image", label: "上传图片", icon: <FileImage size={16} /> },
      { key: "image-url", label: "图片链接", icon: <Link2 size={16} /> },
      { key: "document-url", label: "文档链接", icon: <FileText size={16} /> },
    ],
    onClick: handleAttachmentMenuClick,
  };
  const senderHeaderOpen = attachments.length > 0 || references.length > 0;
  const senderHeaderTitle = buildSenderHeaderTitle(references.length, attachments.length);
  const currentManifest = conversation?.latestRun?.contextManifest || conversation?.lastRun?.contextManifest || null;

  return (
    <div className={`app-shell${contextExpanded ? "" : " context-collapsed"}`}>
      {toastContext}
      <aside className="conversation-sidebar desktop-only">
        <ConversationPanel
          conversations={conversations}
          currentId={currentConversationId}
          activeRun={activeRun}
          gateway={gateway}
          gatewayChecking={gatewayChecking}
          onChange={handleConversationChange}
          onCreate={handleCreateConversation}
          onRefreshGateway={handleRefreshGateway}
        />
      </aside>

      <main className="chat-workspace">
        <header className="chat-header">
          <Tooltip title="会话">
            <Button
              className="mobile-only"
              type="text"
              icon={<Menu size={19} />}
              aria-label="打开会话列表"
              onClick={openConversationDrawer}
            />
          </Tooltip>
          <div className="chat-heading">
            <Title level={4}>{conversation?.title || "AI 应用基础平台"}</Title>
            <div className="chat-subheading">
              <Tag color={conversation?.status === "closed" ? "default" : "green"}>
                {conversationStatusLabel(conversation?.status)}
              </Tag>
              {activeRun ? <Tag color="processing">{activeRun.status === "stopping" ? "正在停止" : "生成中"}</Tag> : null}
              {lastLatency != null ? <Text type="secondary">{lastLatency} ms</Text> : null}
            </div>
          </div>
          <div className="chat-header-actions">
            <Tooltip title="结束会话">
              <Button
                type="text"
                icon={<Archive size={18} />}
                aria-label="结束当前会话"
                disabled={!conversation || conversation.status !== "active" || Boolean(activeRun)}
                onClick={handleCloseConversation}
              />
            </Tooltip>
            <Tooltip title={contextExpanded ? "收起运行上下文" : "展开运行上下文"}>
              <Button
                className={`desktop-only context-toggle${conversation?.latestRun?.status === "failed" ? " has-error" : ""}`}
                type="text"
                icon={<PanelRight size={19} />}
                aria-label={contextExpanded ? "收起运行上下文" : "展开运行上下文"}
                aria-pressed={contextExpanded}
                onClick={toggleContextInspector}
              />
            </Tooltip>
            <Tooltip title="运行上下文">
              <Button
                className="mobile-only"
                type="text"
                icon={<PanelRight size={19} />}
                aria-label="打开运行上下文"
                onClick={openContextDrawer}
              />
            </Tooltip>
          </div>
        </header>

        <section className="message-stage" aria-label="会话消息">
          {initializing || (!conversation && !runError) ? (
            <div className="center-state"><Bot className="loading-bot" size={28} /></div>
          ) : visibleMessages.length === 0 ? (
            <EmptyConversation onPromptClick={handlePromptClick} />
          ) : (
            <Bubble.List
              ref={messageListRef}
              className="message-list"
              items={bubbleItems}
              autoScroll
              onScroll={handleMessageListScroll}
            />
          )}
          <ConversationAnchorRail
            messages={visibleMessages}
            onNavigate={handleNavigateToMessage}
          />
          {!isFollowingLatest && visibleMessages.length > 0 ? (
            <Button
              className="return-to-latest"
              size="small"
              icon={<ArrowDown size={14} />}
              aria-label={unseenMessageCount > 0 ? `回到最新，${unseenMessageCount} 条新消息` : "回到最新"}
              onClick={handleReturnToLatest}
            >
              {unseenMessageCount > 0 ? `回到最新 · ${unseenMessageCount}` : "回到最新"}
            </Button>
          ) : null}
        </section>

        <section className="composer-dock" aria-label="消息输入">
          {gateway?.ok === false ? (
            <Alert
              className="gateway-alert"
              type="warning"
              showIcon
              message="模型网关不可达，当前输入会保留但无法发送"
              action={(
                <Button size="small" loading={gatewayChecking} onClick={handleRefreshGateway}>
                  重新检测
                </Button>
              )}
            />
          ) : null}
          {runError ? <Alert type="error" showIcon closable message={runError} onClose={clearRunError} /> : null}
          <Sender
            value={composerValue}
            loading={Boolean(activeRun)}
            disabled={!conversation || conversation.status !== "active"}
            placeholder={conversation?.status === "closed" ? "当前会话已结束" : "输入消息"}
            autoSize={{ minRows: 1, maxRows: 6 }}
            onChange={handleComposerChange}
            onSubmit={handleSubmit}
            onCancel={handleCancelGeneration}
            onPasteFile={handlePasteFiles}
            prefix={
              <Dropdown menu={attachmentMenu} trigger={["click"]} disabled={Boolean(activeRun)}>
                <Tooltip title="添加附件">
                  <Button type="text" shape="circle" icon={<Paperclip size={18} />} aria-label="添加附件" />
                </Tooltip>
              </Dropdown>
            }
            suffix={renderSenderSuffix}
            footer={renderSenderFooter}
            header={
              <Sender.Header forceRender open={senderHeaderOpen} title={senderHeaderTitle} closable={false}>
                <ReferenceQueue references={references} onRemove={handleRemoveReference} />
                <Attachments
                  ref={attachmentComponentRef}
                  className={attachments.length === 0 ? "attachment-uploader-empty" : undefined}
                  items={attachments}
                  accept="image/*"
                  multiple
                  maxCount={MAX_ATTACHMENTS}
                  beforeUpload={handleBeforeUpload}
                  onRemove={handleRemoveAttachment}
                  overflow="scrollX"
                />
              </Sender.Header>
            }
          />
        </section>
      </main>

      <aside className="context-sidebar desktop-only" hidden={!contextExpanded}>
        <ContextPanel conversation={conversation} manifest={currentManifest} activeRun={activeRun} />
      </aside>

      <Drawer
        className="mobile-drawer"
        title="会话"
        placement="left"
        width="min(88vw, 320px)"
        open={conversationDrawerOpen}
        onClose={closeConversationDrawer}
      >
        <ConversationPanel
          conversations={conversations}
          currentId={currentConversationId}
          activeRun={activeRun}
          gateway={gateway}
          gatewayChecking={gatewayChecking}
          onChange={handleConversationChange}
          onCreate={handleCreateConversation}
          onRefreshGateway={handleRefreshGateway}
        />
      </Drawer>
      <Drawer
        className="mobile-drawer"
        title="运行上下文"
        placement="right"
        width="min(92vw, 360px)"
        open={contextDrawerOpen}
        onClose={closeContextDrawer}
      >
        <ContextPanel conversation={conversation} manifest={currentManifest} activeRun={activeRun} />
      </Drawer>

      <Modal
        title={linkDraft.type === "image" ? "添加图片链接" : "添加文档链接"}
        open={linkDraft.open}
        okText="添加"
        cancelText="取消"
        onOk={confirmLinkDraft}
        onCancel={closeLinkDraft}
      >
        <Input
          autoFocus
          value={linkDraft.value}
          status={linkDraft.error ? "error" : undefined}
          placeholder="https://"
          prefix={linkDraft.type === "image" ? <FileImage size={16} /> : <FileText size={16} />}
          onChange={handleLinkDraftChange}
          onPressEnter={confirmLinkDraft}
        />
        {linkDraft.error ? <Text className="field-error" type="danger">{linkDraft.error}</Text> : null}
      </Modal>
    </div>
  );
}

/** 渲染品牌、网关状态和受控会话列表。 */
function ConversationPanel({
  conversations,
  currentId,
  activeRun,
  gateway,
  gatewayChecking,
  onChange,
  onCreate,
  onRefreshGateway,
}) {
  const gatewayCopy = buildGatewayReachabilityCopy(gateway);
  const items = [];
  for (const item of conversations) {
    items.push({
      key: item.id,
      disabled: Boolean(activeRun && item.id !== currentId),
      label: (
        <div className="conversation-label">
          <span className="conversation-name">{item.title}</span>
          <span className="conversation-meta">
            {conversationStatusLabel(item.status)} · {item.messageCount} 条
          </span>
        </div>
      ),
    });
  }
  return (
    <div className="conversation-panel">
      <div className="brand-lockup">
        <span className="brand-mark"><Bot size={21} /></span>
        <div>
          <strong>AI 应用基础平台</strong>
          <span>C1 对话</span>
        </div>
      </div>
      <div className="gateway-line">
        <span className={`gateway-dot is-${gatewayCopy.state}`} />
        <Tooltip title={gatewayCopy.detail}>
          <Text ellipsis>{gatewayCopy.label}</Text>
        </Tooltip>
        <Tooltip title="重新检测模型网关">
          <Button
            className="gateway-refresh"
            type="text"
            size="small"
            loading={gatewayChecking}
            icon={<RefreshCw size={14} />}
            aria-label="重新检测模型网关"
            onClick={onRefreshGateway}
          />
        </Tooltip>
      </div>
      <Conversations
        className="conversation-list"
        items={items}
        activeKey={currentId || undefined}
        onActiveChange={onChange}
        creation={{
          label: "新建会话",
          icon: <Plus size={17} />,
          disabled: Boolean(activeRun),
          onClick: onCreate,
        }}
      />
      <div className="sidebar-footer">{conversations.length} 个会话</div>
    </div>
  );
}

/** 渲染空会话的克制入口和可直接填入的建议。 */
function EmptyConversation({ onPromptClick }) {
  const promptItems = [
    { key: "summary", label: "总结这段会话的关键决策" },
    { key: "boundary", label: "检查当前方案的边界与风险" },
    { key: "next", label: "基于已有上下文给出下一步" },
  ];
  return (
    <div className="empty-conversation">
      <Welcome icon={<Bot size={28} />} title="开始新的对话" variant="borderless" />
      <Prompts items={promptItems} wrap onItemClick={onPromptClick} />
    </div>
  );
}

/** 渲染待发送引用，并以 messageId 为删除边界。 */
function ReferenceQueue({ references, onRemove }) {
  if (references.length === 0) return null;
  const nodes = [];
  for (const reference of references) {
    /** 从当前闭包引用稳定 ID，移除时不依赖列表索引。 */
    function removeCurrentReference() {
      onRemove(reference.messageId);
    }
    nodes.push(
      <div className="reference-chip" key={reference.messageId}>
        <MessageSquareQuote size={15} />
        <span><strong>{reference.role === "assistant" ? "助手" : "用户"}</strong>{reference.preview}</span>
        <Tooltip title="移除引用">
          <Button type="text" size="small" icon={<X size={14} />} aria-label="移除引用" onClick={removeCurrentReference} />
        </Tooltip>
      </div>,
    );
  }
  return <div className="reference-queue">{nodes}</div>;
}

/** 渲染消息正文、可定位引用预览和图片事实。 */
function MessageBody({ message, streaming = false, referenceMessages = [], onNavigateReference }) {
  const imageUrls = getMessageImageUrls(message);
  const hasDisplayContent = Boolean(String(message.displayContent || "").trim());
  const referenceNodes = [];
  for (const referenceMessage of referenceMessages) {
    referenceNodes.push(
      <ReferencedMessage
        key={referenceMessage.id}
        message={referenceMessage}
        onNavigate={onNavigateReference}
      />,
    );
  }
  return (
    <div
      id={messageElementId(message.id)}
      className="message-body-content"
      data-message-id={message.id}
      tabIndex={-1}
    >
      {referenceMessages.length > 0 ? (
        <div className="message-references">{referenceNodes}</div>
      ) : null}
      {imageUrls.length > 0 ? (
        <div className="message-images">
          {imageUrls.map(renderMessageImage)}
        </div>
      ) : null}
      {streaming ? (
        <div className="message-generation-status" role="status" aria-live="polite">
          <LoaderCircle className="message-generation-spinner" size={14} />
          <span>{activeRunStageLabel(message.runStatus, hasDisplayContent)}</span>
        </div>
      ) : null}
      {hasDisplayContent || !streaming ? (
        <XMarkdown
          content={message.displayContent || "(空消息)"}
          streaming={streaming ? { hasNextChunk: true, enableAnimation: true, tail: true } : undefined}
          escapeRawHtml
          openLinksInNewTab
        />
      ) : null}
      {message.status === "interrupted" ? <Tag className="message-status-tag">已停止</Tag> : null}
    </div>
  );
}

/** 将一条被引用消息渲染为可定位到来源的只读证据预览。 */
function ReferencedMessage({ message, onNavigate }) {
  /** 使用稳定 messageId 请求页面定位来源消息。 */
  function navigateToSource() {
    onNavigate(message.id);
  }
  return (
    <button className="message-reference" type="button" onClick={navigateToSource}>
      <Quote size={14} />
      <span>{buildMessagePreview(message.displayContent)}</span>
    </button>
  );
}

/** 将消息中的图片 URL 渲染为受约束缩略图。 */
function renderMessageImage(url) {
  return <Image key={url.slice(0, 96)} src={url} alt="消息图片" width={112} height={84} />;
}

/** 渲染桌面快捷操作和移动端单一菜单；已持久化消息不提供删除或编辑。 */
function MessageActions({ message, onQuote, onCopy }) {
  /** 把当前稳定消息交给页面引用队列。 */
  function quoteCurrentMessage() {
    onQuote(message);
  }
  /** 把当前消息正文交给页面统一复制反馈。 */
  function copyCurrentMessage() {
    void onCopy(message);
  }
  /** 将移动端菜单命令映射到同一复制和引用动作。 */
  function handleMobileMessageAction({ key }) {
    if (key === "copy") copyCurrentMessage();
    if (key === "quote") quoteCurrentMessage();
  }
  const quoteActions = [
    {
      key: "quote",
      label: "引用",
      actionRender: (
        <Tooltip title="引用">
          <Button
            type="text"
            size="small"
            icon={<Quote size={15} />}
            aria-label="引用消息"
            onClick={quoteCurrentMessage}
          />
        </Tooltip>
      ),
    },
  ];
  const mobileMenu = {
    items: [
      { key: "copy", label: "复制", icon: <Copy size={15} /> },
      { key: "quote", label: "引用", icon: <Quote size={15} /> },
    ],
    onClick: handleMobileMessageAction,
  };
  return (
    <div className="message-actions">
      <div className="desktop-message-actions">
        <Tooltip title="复制">
          <Actions.Copy text={message.displayContent || ""} aria-label="复制消息" />
        </Tooltip>
        <Actions items={quoteActions} />
      </div>
      <Dropdown menu={mobileMenu} trigger={["click"]}>
        <Button
          className="mobile-message-actions"
          type="text"
          size="small"
          icon={<Ellipsis size={17} />}
          aria-label="消息操作"
        />
      </Dropdown>
    </div>
  );
}

/** 渲染持久失败状态和不改变 Runtime 契约的恢复入口。 */
function RunFailureNotice({ message, onRestore, onOpenContext }) {
  const failure = message.failure || buildRunFailureCopy(message);
  /** 恢复与失败 Run 关联的稳定用户消息。 */
  function restoreSourceInput() {
    onRestore(message.sourceMessageId);
  }
  return (
    <div id={messageElementId(message.id)} className="run-failure-notice" role="status" tabIndex={-1}>
      <CircleAlert size={18} />
      <div className="run-failure-copy">
        <strong>{failure.title}</strong>
        <span>{failure.detail}</span>
        <span className="run-failure-recovery">{failure.action} 输入已保存。</span>
      </div>
      <div className="run-failure-actions">
        <Button size="small" icon={<RotateCcw size={14} />} onClick={restoreSourceInput}>恢复输入</Button>
        <Button size="small" type="text" onClick={onOpenContext}>运行信息</Button>
      </div>
    </div>
  );
}

/** 把会话消息和活动 Run 转换为 Ant Design X Bubble 数据。 */
function buildBubbleItems(messages, handlers) {
  const persistedMessages = [];
  for (const message of messages) {
    if (!message.streaming) persistedMessages.push(message);
  }
  const items = [];
  for (const message of messages) {
    if (message.kind === "run-failure") {
      items.push({
        key: message.id,
        role: "ai",
        placement: "start",
        variant: "borderless",
        content: (
          <RunFailureNotice
            message={message}
            onRestore={handlers.onRestoreFailedInput}
            onOpenContext={handlers.onOpenContext}
          />
        ),
      });
      continue;
    }
    const isAssistant = message.role === "assistant";
    const referenceMessages = resolveReferenceMessages(message.references, persistedMessages);
    items.push({
      key: message.id,
      role: isAssistant ? "ai" : "user",
      placement: isAssistant ? "start" : "end",
      variant: isAssistant ? "borderless" : "filled",
      status: message.status === "interrupted" ? "abort" : message.streaming ? "updating" : "success",
      streaming: Boolean(message.streaming),
      loading: false,
      content: (
        <MessageBody
          message={message}
          streaming={message.streaming}
          referenceMessages={referenceMessages}
          onNavigateReference={handlers.onNavigateReference}
        />
      ),
      footer:
        message.streaming ||
        String(message.id).startsWith("optimistic:") ||
        String(message.id).startsWith("streaming:") ? null : (
          <MessageActions message={message} onQuote={handlers.onQuote} onCopy={handlers.onCopy} />
        ),
    });
  }
  return items;
}

/** 在服务端消息基线上追加当前渠道尚未收口的乐观消息。 */
function buildVisibleMessages(conversation, activeRun, currentConversationId) {
  const messages = conversation?.messages ? [...conversation.messages] : [];
  if (!activeRun || activeRun.conversationId !== currentConversationId) {
    return insertLatestRunFailure(messages, conversation?.latestRun);
  }
  messages.push(activeRun.optimisticUser);
  if (activeRun.status === "cancelled" && !activeRun.partialText) return messages;
  messages.push({
    id: `streaming:${activeRun.requestId}`,
    conversationId: activeRun.conversationId,
    role: "assistant",
    displayContent: activeRun.partialText,
    status: activeRun.status === "cancelled" ? "interrupted" : "committed",
    references: [],
    streaming: activeRun.status !== "cancelled",
    runStatus: activeRun.status,
  });
  return messages;
}

/** 使用服务端已返回的当前会话消息解析引用预览。 */
function resolveReferenceMessages(references, messages) {
  const resolved = [];
  if (!Array.isArray(references)) return resolved;
  for (const reference of references) {
    if (reference.type !== "conversation_message") continue;
    for (const message of messages) {
      if (message.id === reference.messageId) {
        resolved.push(message);
        break;
      }
    }
  }
  return resolved;
}

/** 生成只包含模型别名、当前输入、附件地址、引用 ID 和幂等标识的 Run 载荷。 */
function buildRunPayload(value, attachments, references, model) {
  const imageUrls = [];
  const documentUrls = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image") imageUrls.push(attachment.url);
    else documentUrls.push(attachment.url);
  }
  const stableReferences = [];
  for (const reference of references) {
    stableReferences.push({ type: "conversation_message", messageId: reference.messageId });
  }
  return {
    requestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    model: String(model || "").trim(),
    message: String(value || "").trim(),
    imageUrls,
    documentUrls,
    references: stableReferences,
  };
}

/** 判断 Run 是否至少包含正文、附件或稳定消息引用。 */
function hasRunInput(payload) {
  return Boolean(
    payload.message || payload.imageUrls.length || payload.documentUrls.length || payload.references.length,
  );
}

/** 为活动 Run 构造不进入事实源的乐观用户消息。 */
function buildOptimisticUserMessage(conversationId, payload) {
  return {
    id: `optimistic:${payload.clientMessageId}`,
    conversationId,
    clientMessageId: payload.clientMessageId,
    role: "user",
    displayContent: formatDisplayInput(payload),
    status: "local",
    references: payload.references,
    imageUrls: payload.imageUrls,
  };
}

/** 将 Run 输入转换为与服务端 displayContent 一致的乐观文本。 */
function formatDisplayInput(payload) {
  const sections = [];
  if (payload.message) sections.push(payload.message);
  if (payload.imageUrls.length > 0) sections.push(`图片：${payload.imageUrls.length} 个`);
  if (payload.documentUrls.length > 0) {
    const links = [];
    for (const url of payload.documentUrls) links.push(`- ${url}`);
    sections.push(`参考文档链接：\n${links.join("\n")}`);
  }
  if (sections.length === 0 && payload.references.length > 0) sections.push(`引用了 ${payload.references.length} 条消息`);
  return sections.join("\n\n");
}

/** 从持久化多模态 content 或乐观快照提取图片地址。 */
function getMessageImageUrls(message) {
  if (Array.isArray(message.imageUrls)) return message.imageUrls;
  const urls = [];
  if (!Array.isArray(message.content)) return urls;
  for (const part of message.content) {
    if (part?.type === "image_url" && part.image_url?.url) urls.push(part.image_url.url);
  }
  return urls;
}

/** 把恢复出的图片和文档地址转换为受控 Attachments 项，并继续执行渠道数量上限。 */
function buildRecoveredAttachments(imageUrls, documentUrls) {
  const items = [];
  for (const url of imageUrls.slice(0, MAX_IMAGES)) {
    if (items.length >= MAX_ATTACHMENTS) break;
    items.push(createRecoveredAttachment(url, "image", items.length));
  }
  for (const url of documentUrls) {
    if (items.length >= MAX_ATTACHMENTS) break;
    items.push(createRecoveredAttachment(url, "document", items.length));
  }
  return items;
}

/** 为一条持久化附件地址创建新的渠道局部身份，不复用旧上传组件状态。 */
function createRecoveredAttachment(url, kind, index) {
  const isImage = kind === "image";
  return {
    uid: crypto.randomUUID(),
    name: isImage && String(url).startsWith("data:") ? `恢复图片-${index + 1}` : readableUrlName(url),
    status: "done",
    url,
    thumbUrl: isImage ? url : undefined,
    cardType: isImage ? "image" : "file",
    kind,
    description: isImage ? "图片" : "文档链接",
  };
}

/** 按当前会话消息补齐恢复引用的角色和预览，缺失来源不会进入草稿。 */
function buildRecoveredReferences(references, messages) {
  const facts = [];
  for (const reference of references) {
    if (facts.length >= MAX_REFERENCES) break;
    const source = messages.find(
      // 恢复引用只匹配当前会话内同 ID 的服务端消息。
      (message) => message.id === reference.messageId,
    );
    if (!source) continue;
    facts.push({
      type: "conversation_message",
      messageId: source.id,
      role: source.role,
      preview: buildMessagePreview(source.displayContent),
    });
  }
  return facts;
}

/** 生成无需 CSS 转义即可由 DOM API 精确查找的消息锚点。 */
function messageElementId(messageId) {
  return `conversation-message-${String(messageId)}`;
}

/** 将浏览器 File 对象异步读取为 data URL。 */
function readFileAsDataUrl(file) {
  return new Promise(
    // Promise executor 只桥接 FileReader 事件，不改变文件内容或持久化附件。
    (resolve, reject) => {
      const reader = new FileReader();
      /** 返回 FileReader 已完成的 data URL。 */
      function handleLoad() {
        resolve(String(reader.result));
      }
      reader.addEventListener("load", handleLoad);
      reader.addEventListener("error", reject);
      reader.readAsDataURL(file);
    },
  );
}

/** 统计当前受控附件中的图片数量。 */
function countImageAttachments(items) {
  let count = 0;
  for (const item of items) if (item.kind === "image") count += 1;
  return count;
}

/** 只接受 Runtime 当前已开放的 http(s) 链接协议。 */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 从 URL 生成适合附件列表扫描的短名称。 */
function readableUrlName(value) {
  try {
    const url = new URL(value);
    const tail = url.pathname.split("/").filter(Boolean).at(-1);
    return tail || url.hostname;
  } catch {
    return value;
  }
}

/** 组合 Sender Header 中的引用与附件计数。 */
function buildSenderHeaderTitle(referenceCount, attachmentCount) {
  const parts = [];
  if (referenceCount) parts.push(`${referenceCount} 条引用`);
  if (attachmentCount) parts.push(`${attachmentCount} 个附件`);
  return parts.join(" · ");
}

/** 渲染最新 Run Context Manifest 与 active 结构化记忆。 */
function ContextPanel({ conversation, manifest, activeRun }) {
  if (!conversation) return <div className="context-panel"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /></div>;
  const memoryItems = [];
  for (const item of conversation.memory?.items || []) {
    if (item.status === "active") memoryItems.push(item);
  }
  const selected = manifest?.selected || {};
  const tokenPercent = manifest?.budget ? Math.min(100, Math.round((manifest.countedTokens / manifest.budget) * 100)) : 0;
  const latestStatus = activeRun ? activeRun.status : conversation.latestRun?.status || "idle";
  return (
    <div className="context-panel">
      <div className="context-heading">
        <div>
          <Text type="secondary">运行上下文</Text>
          <Title level={5}>Context Manifest</Title>
        </div>
        <Tag color={runStatusColor(latestStatus)}>{runStatusLabel(latestStatus)}</Tag>
      </div>

      <section className="context-section">
        <div className="section-title"><Gauge size={16} /><span>Token</span></div>
        <div className="token-line">
          <strong>{manifest ? `${manifest.countedTokens} / ${manifest.budget}` : "-"}</strong>
          <span>{manifest?.tokenCounter || "等待 Run"}</span>
        </div>
        <Progress percent={tokenPercent} showInfo={false} strokeColor="#1677ff" trailColor="#e8eaed" />
        <div className="watermark-row">
          <Tag color={manifest?.highWatermarkReached ? "orange" : "default"}>高水位</Tag>
          <Tag color={manifest?.hardLimitReached ? "red" : "default"}>硬水位</Tag>
        </div>
      </section>

      <section className="context-section">
        <div className="section-title"><Database size={16} /><span>装箱结果</span></div>
        <div className="metric-grid">
          <Metric label="直接引用" value={countItems(selected.referenceMessageIds)} />
          <Metric label="结构记忆" value={countItems(selected.memoryItemIds)} />
          <Metric label="Episode" value={countItems(selected.episodeIds)} />
          <Metric label="历史消息" value={countItems(selected.historyMessageIds)} />
        </div>
        <Text className="context-version" type="secondary">
          会话 v{conversation.version} · 记忆 v{conversation.memory?.version ?? 0} · seq {conversation.lastSeq}
        </Text>
      </section>

      <section className="context-section memory-section">
        <div className="section-title"><Brain size={16} /><span>结构化记忆</span><Tag>{memoryItems.length}</Tag></div>
        {memoryItems.length === 0 ? (
          <Text type="secondary">暂无 active 记忆</Text>
        ) : (
          <div className="memory-list">{memoryItems.slice(0, 12).map(renderMemoryItem)}</div>
        )}
      </section>
    </div>
  );
}

/** 渲染单个 Context 指标。 */
function Metric({ label, value }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

/** 渲染一条 active 结构化记忆。 */
function renderMemoryItem(item) {
  return (
    <div className="memory-item" key={item.id}>
      <span>{item.type} · {item.entity}.{item.key}</span>
      <strong>{formatMemoryValue(item.value)}</strong>
    </div>
  );
}

/** 将结构化记忆值转换为可扫描文本。 */
function formatMemoryValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** 安全读取可选 ID 数组长度。 */
function countItems(value) {
  return Array.isArray(value) ? value.length : 0;
}

/** 把 Runtime 状态映射为中文渠道标签。 */
function runStatusLabel(status) {
  const labels = {
    idle: "等待运行",
    starting: "正在创建",
    running: "生成中",
    stopping: "正在停止",
    completed: "已完成",
    cancelled: "已取消",
    failed: "失败",
  };
  return labels[status] || status;
}

/** 把 Runtime 状态映射为 Ant Design Tag 色彩。 */
function runStatusColor(status) {
  if (status === "running" || status === "starting" || status === "stopping") return "processing";
  if (status === "completed") return "green";
  if (status === "cancelled") return "orange";
  if (status === "failed") return "red";
  return "default";
}
